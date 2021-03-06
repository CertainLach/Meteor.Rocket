import Router from '@meteor-it/router';
import { configure, isObservableArray, isObservableMap } from 'mobx';
import { IUninitializedStoreMap, initStores } from '../stores';
import { Provider } from 'inferno-mobx';
import Logger from '@meteor-it/logger';

/**
 * Helper function that supports merging maps
 * @param target
 * @param source
 */
function mergeObservables(target, source) {
    if (!source) {
        return;
    } else {
        Object.keys(source).forEach(key => {
            if (typeof target[key] === 'object') {
                if (isObservableMap(target[key])) return target[key].merge(source[key]);
                if (isObservableArray(target[key])) return target[key].replace(source[key]);
                target[key] = source[key];
            } else {
                target[key] = source[key];
            }
        });
    }
}

export type IRocketRouterContext = {
    query: { [key: string]: string }
};
export type IRocketRouterState<S> = {
    drawTarget: JSX.Element | null,
    store: S,
    redirectTarget: string
};
export type IRocketRouterMethodList = any;

export class InternalRedirectThrowable extends Error {
    url: string;
    constructor(url: string) {
        super('this is not really a error');
        this.url = url;
    }
}

configure({
    enforceActions: 'never',
    isolateGlobalState: true
});

const logger = new Logger('Rocket.Router');

let browserSavedStore = null;
export function getInitialRouter<S>(stateGetter: () => IRocketRouterState<S>, store: IUninitializedStoreMap): Router<IRocketRouterContext, IRocketRouterState<S>, IRocketRouterMethodList> {
    const appRouter = new Router<IRocketRouterContext, IRocketRouterState<S>, IRocketRouterMethodList>(stateGetter);
    // All of initial tree setup must be here
    appRouter.on('ALL', null, async ({ state, next, resolve, path, query }) => {
        let proceedStore = null;
        if (process.env.BROWSER) {
            if (browserSavedStore === null) {
                browserSavedStore = await initStores(store);
                if(process.env.NODE_ENV!=='development'){
                    let ssrStores = (window as any).__SSR_STORE__;
                    if (ssrStores) {
                        // Clean up
                        delete (window as any).__SSR_STORE__;
                        for (let key in ssrStores) {
                            mergeObservables(browserSavedStore[key], ssrStores[key]);
                        }
                    }
                }else{
                    (window as any).__STORE__ = browserSavedStore;
                }
            }
            proceedStore = browserSavedStore;
        } else {
            proceedStore = await initStores(store);
        }
        proceedStore.router.path = path;
        proceedStore.router.query = query;
        state.store = proceedStore;
        try {
            await next();
        } catch (e) {
            if (e instanceof InternalRedirectThrowable) {
                state.redirectTarget = e.url;
                resolve(null);
            } else {
                logger.err('Failed to render something after processing routing');
                logger.err(e.stack);
                // TODO: Display error somehow?
            }
            return;
        }
        state.drawTarget = (
            <Provider {...state.store}>
                {(state.drawTarget)}
            </Provider>
        )
    });
    return appRouter;
}