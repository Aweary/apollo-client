import {
  NetworkInterface,
  Request,
  BatchedNetworkInterface,
} from './networkInterface';


import forOwn = require('lodash.forown');
import assign = require('lodash.assign');
import isEqual = require('lodash.isequal');

import {
  ApolloStore,
  Store,
} from './store';

import {
  SelectionSetWithRoot,
  QueryStoreValue,
} from './queries/store';

import {
  getMutationDefinition,
  getQueryDefinition,
  replaceOperationDefinition,
  getFragmentDefinitions,
  createFragmentMap,
} from './queries/getFromAST';

import {
  QueryTransformer,
  applyTransformerToOperation,
} from './queries/queryTransform';

import {
  GraphQLResult,
  Document,
} from 'graphql';

import { print } from 'graphql/language/printer';

import {
  readSelectionSetFromStore,
} from './data/readFromStore';

import {
  diffSelectionSetAgainstStore,
} from './data/diffAgainstStore';

import {
  queryDocument,
} from './queryPrinting';

import {
  QueryFetchRequest,
  QueryBatcher,
} from './batching';

import {
  QueryScheduler,
} from './scheduler';

import { Observable, Observer, Subscription } from './util/Observable';

export class ObservableQuery extends Observable<GraphQLResult> {
  public subscribe(observer: Observer<GraphQLResult>): QuerySubscription {
    return super.subscribe(observer) as QuerySubscription;
  }


  public result(): Promise<GraphQLResult> {
    return new Promise((resolve, reject) => {
      const subscription = this.subscribe({
        next(result) {
          resolve(result);
          setTimeout(() => {
            subscription.unsubscribe();
          }, 0);
        },
        error(error) {
          reject(error);
        },
      });
    });
  }
}

export interface QuerySubscription extends Subscription {
  refetch(variables?: any): Promise<GraphQLResult>;
  stopPolling(): void;
  startPolling(pollInterval: number): void;
}

export interface WatchQueryOptions {
  query: Document;
  variables?: { [key: string]: any };
  forceFetch?: boolean;
  returnPartialData?: boolean;
  pollInterval?: number;
}

export type QueryListener = (queryStoreValue: QueryStoreValue) => void

export class QueryManager {
  private networkInterface: NetworkInterface;
  private store: ApolloStore;
  private reduxRootKey: string;

  private queryTransformer: QueryTransformer;
  private queryListeners: { [queryId: string]: QueryListener };

  private idCounter = 0;

  private scheduler: QueryScheduler;
  private batcher: QueryBatcher;
  private batcherPollInterval = 25;

  constructor({
    networkInterface,
    store,
    reduxRootKey,
    queryTransformer,
    shouldBatch,
  }: {
    networkInterface: NetworkInterface,
    store: ApolloStore,
    reduxRootKey: string,
    queryTransformer?: QueryTransformer,
    shouldBatch?: Boolean,
  }) {
    // XXX this might be the place to do introspection for inserting the `id` into the query? or
    // is that the network interface?
    this.networkInterface = networkInterface;
    this.store = store;
    this.reduxRootKey = reduxRootKey;
    this.queryTransformer = queryTransformer;


    const isBatchingInterface =
      (this.networkInterface as BatchedNetworkInterface).batchQuery !== undefined;
    this.queryListeners = {};
    this.scheduler = new QueryScheduler({
      queryManager: this,
    });
    this.batcher = new QueryBatcher({
      //we batch if the network interface supports batching if user has not specified
      shouldBatch: shouldBatch || isBatchingInterface,
      networkInterface: this.networkInterface,
    });
    this.batcher.start(this.batcherPollInterval);

    // this.store is usually the fake store we get from the Redux middleware API
    // XXX for tests, we sometimes pass in a real Redux store into the QueryManager
    if (this.store['subscribe']) {
      let currentStoreData;
      this.store['subscribe'](() => {
        let previousStoreData = currentStoreData || {};
        const previousStoreHasData = Object.keys(previousStoreData).length;
        currentStoreData = this.getApolloState();
        if (isEqual(previousStoreData, currentStoreData) && previousStoreHasData) {
          return;
        }
        this.broadcastQueries();
      });
    }
  }

  // Called from middleware
  public broadcastNewStore(store: any) {
    this.broadcastQueries();
  }

  public mutate({
    mutation,
    variables,
  }: {
    mutation: Document,
    variables?: Object,
  }): Promise<GraphQLResult> {
    const mutationId = this.generateQueryId();

    let mutationDef = getMutationDefinition(mutation);
    if (this.queryTransformer) {
      mutationDef = applyTransformerToOperation(mutationDef, this.queryTransformer);
      mutation = replaceOperationDefinition(mutation, mutationDef);
    }
    mutation = replaceOperationDefinition(mutation, mutationDef);
    const mutationString = print(mutation);
    const queryFragmentMap = createFragmentMap(getFragmentDefinitions(mutation));
    const request = {
      query: mutation,
      variables,
    } as Request;

    this.store.dispatch({
      type: 'APOLLO_MUTATION_INIT',
      mutationString,
      mutation: {
        id: 'ROOT_MUTATION',
        typeName: 'Mutation',
        selectionSet: mutationDef.selectionSet,
      },
      variables,
      mutationId,
      fragmentMap: queryFragmentMap,
    });

    return this.networkInterface.query(request)
      .then((result) => {
        this.store.dispatch({
          type: 'APOLLO_MUTATION_RESULT',
          result,
          mutationId,
        });

        return result;

      });
  }

  // Returns a query listener that will update the given observer based on the
  // results (or lack thereof) for a particular query.
  public queryListenerForObserver(options: WatchQueryOptions,
                                  observer: Observer<GraphQLResult>): QueryListener {
    return (queryStoreValue: QueryStoreValue) => {
      if (!queryStoreValue.loading || queryStoreValue.returnPartialData) {
        // XXX Currently, returning errors and data is exclusive because we
        // don't handle partial results
        if (queryStoreValue.graphQLErrors) {
          if (observer.next) {
            observer.next({ errors: queryStoreValue.graphQLErrors });
          }
        } else if (queryStoreValue.networkError) {
          // XXX we might not want to re-broadcast the same error over and over if it didn't change
          if (observer.error) {
            observer.error(queryStoreValue.networkError);
          } else {
            console.error('Unhandled network error',
                          queryStoreValue.networkError,
                          queryStoreValue.networkError.stack);
          }
        } else {
          const resultFromStore = readSelectionSetFromStore({
            store: this.getApolloState().data,
            rootId: queryStoreValue.query.id,
            selectionSet: queryStoreValue.query.selectionSet,
            variables: queryStoreValue.variables,
            returnPartialData: options.returnPartialData,
            fragmentMap: queryStoreValue.fragmentMap,
          });

          if (observer.next) {
            observer.next({ data: resultFromStore });
          }
        }
      }
    };
  }

  public watchQuery(options: WatchQueryOptions): ObservableQuery {
    // Call just to get errors synchronously
    getQueryDefinition(options.query);

    // If we have a polling query, that should be handled by the scheduler.
    if (options.pollInterval) {
      return this.scheduler.registerPollingQuery(options);
    }

    return new ObservableQuery((observer) => {
      const listener = this.queryListenerForObserver(options, observer);
      const queryId = this.startQuery(options, listener);
      // const queryId = this.generateQueryId();

      return {
        unsubscribe: () => {
          this.stopQuery(queryId);
        },
        refetch: (variables: any): Promise<GraphQLResult> => {
          // If no new variables passed, use existing variables
          variables = variables || options.variables;

          // Use the same options as before, but with new variables and forceFetch true
          return this.fetchQuery(queryId, assign(options, {
            forceFetch: true,
            variables,
          }) as WatchQueryOptions);
        },
        stopPolling: (): void => {
          this.scheduler.stopPollingQuery(queryId);
        },
        startPolling: (pollInterval): void => {
          this.scheduler.startPollingQuery(assign(options, {
            pollInterval,
          }) as WatchQueryOptions, listener, queryId);
        },
      };
    });
  }

  public query(options: WatchQueryOptions): Promise<GraphQLResult> {
    if (options.returnPartialData) {
      throw new Error('returnPartialData option only supported on watchQuery.');
    }

    return this.watchQuery(options).result();
  }


  public generateQueryId() {
    const queryId = this.idCounter.toString();
    this.idCounter++;
    return queryId;
  }

  public stopQueryInStore(queryId: string) {
    this.store.dispatch({
      type: 'APOLLO_QUERY_STOP',
      queryId,
    });
  };

  public getApolloState(): Store {
    return this.store.getState()[this.reduxRootKey];
  }

  public addQueryListener(queryId: string, listener: QueryListener) {
    this.queryListeners[queryId] = listener;
  };

  public removeQueryListener(queryId: string) {
    delete this.queryListeners[queryId];
  }

  public fetchQuery(queryId: string, options: WatchQueryOptions): Promise<GraphQLResult> {
    const {
      query,
      variables,
      forceFetch = false,
      returnPartialData = false,
    } = options;

    let queryDef = getQueryDefinition(query);
    // Apply the query transformer if one has been provided.
    if (this.queryTransformer) {
      queryDef = applyTransformerToOperation(queryDef, this.queryTransformer);
    }
    const transformedQuery = replaceOperationDefinition(query, queryDef);
    const queryString = print(transformedQuery);
    const queryFragmentMap = createFragmentMap(getFragmentDefinitions(transformedQuery));

    // Parse the query passed in -- this could also be done by a build plugin or tagged
    // template string
    const querySS = {
      id: 'ROOT_QUERY',
      typeName: 'Query',
      selectionSet: queryDef.selectionSet,
    } as SelectionSetWithRoot;

    // If we don't use diffing, then these will be the same as the original query, other than
    // the queryTransformer that could have been applied.
    let minimizedQueryString = queryString;
    let minimizedQuery = querySS;
    let minimizedQueryDoc = transformedQuery;
    let initialResult;

    if (!forceFetch) {
      // If the developer has specified they want to use the existing data in the store for this
      // query, use the query diff algorithm to get as much of a result as we can, and identify
      // what data is missing from the store
      const { missingSelectionSets, result } = diffSelectionSetAgainstStore({
        selectionSet: querySS.selectionSet,
        store: this.store.getState()[this.reduxRootKey].data,
        throwOnMissingField: false,
        rootId: querySS.id,
        variables,
        fragmentMap: queryFragmentMap,
      });

      initialResult = result;

      if (missingSelectionSets && missingSelectionSets.length) {
        const diffedQuery = queryDocument({
          missingSelectionSets,
          variableDefinitions: queryDef.variableDefinitions,
          name: queryDef.name,
          fragmentMap: queryFragmentMap,
        });
        const diffedQueryDef = getQueryDefinition(diffedQuery);

        minimizedQuery = {
          id: 'ROOT_QUERY',
          typeName: 'Query',
          selectionSet: diffedQueryDef.selectionSet,
        };

        minimizedQueryString = print(diffedQuery);
        minimizedQueryDoc = diffedQuery;
      } else {
        minimizedQuery = null;
        minimizedQueryString = null;
        minimizedQueryDoc = null;
      }
    }

    const requestId = this.generateRequestId();

    // Initialize query in store with unique requestId
    this.store.dispatch({
      type: 'APOLLO_QUERY_INIT',
      queryString,
      query: querySS,
      minimizedQueryString,
      minimizedQuery,
      variables,
      forceFetch,
      returnPartialData,
      queryId,
      requestId,
      fragmentMap: queryFragmentMap,
    });

    if (! minimizedQuery || returnPartialData) {
      this.store.dispatch({
        type: 'APOLLO_QUERY_RESULT_CLIENT',
        result: {
          data: initialResult,
        },
        variables,
        query: querySS,
        complete: !! minimizedQuery,
        queryId,
      });
    }

    if (minimizedQuery) {
      const fetchRequest: QueryFetchRequest = {
        options: { query: minimizedQueryDoc, variables },
        queryId: queryId,
      };

      return this.batcher.enqueueRequest(fetchRequest)
        .then((result: GraphQLResult) => {
          // XXX handle multiple GraphQLResults
          this.store.dispatch({
            type: 'APOLLO_QUERY_RESULT',
            result,
            queryId,
            requestId,
          });

          return result;
        }).then(() => {

          let resultFromStore;
          try {
            // ensure result is combined with data already in store
            resultFromStore = readSelectionSetFromStore({
              store: this.getApolloState().data,
              rootId: querySS.id,
              selectionSet: querySS.selectionSet,
              variables,
              returnPartialData: returnPartialData,
              fragmentMap: queryFragmentMap,
            });
          // ensure multiple errors don't get thrown
          /* tslint:disable */
          } catch (e) {}
          /* tslint:enable */

          // return a chainable promise
          return new Promise((resolve) => {
            resolve({ data: resultFromStore });
          });
        }).catch((error: Error) => {
          this.store.dispatch({
           type: 'APOLLO_QUERY_ERROR',
            error,
            queryId,
            requestId,
          });

          return error;
        });
    }
    // return a chainable promise
    return new Promise((resolve) => {
      resolve({ data: initialResult });
    });
  }

  private startQuery(options: WatchQueryOptions, listener: QueryListener) {
    const queryId = this.generateQueryId();
    this.queryListeners[queryId] = listener;
    this.fetchQuery(queryId, options);

    // Note: this method should never be called with a query that starts out as polling - those
    // are all handled by the QueryScheduler.
    return queryId;
  }

  private stopQuery(queryId: string) {
    // XXX in the future if we should cancel the request
    // so that it never tries to return data
    delete this.queryListeners[queryId];

    // if we have a polling interval running, stop it
    this.scheduler.stopPollingQuery(queryId);

    this.store.dispatch({
      type: 'APOLLO_QUERY_STOP',
      queryId,
    });
  }

  private broadcastQueries() {
    const queries = this.getApolloState().queries;
    forOwn(this.queryListeners, (listener: QueryListener, queryId: string) => {
      // it's possible for the listener to be undefined if the query is being stopped
      // See here for more detail: https://github.com/apollostack/apollo-client/issues/231
      if (listener) {
        const queryStoreValue = queries[queryId];
        listener(queryStoreValue);
      }
    });
  }

  private generateRequestId() {
    const requestId = this.idCounter;
    this.idCounter++;
    return requestId;
  }
}
