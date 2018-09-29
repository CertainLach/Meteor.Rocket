import { readFile } from '@meteor-it/fs';
import { IRouterContext } from '@meteor-it/router';
import { XPressRouterContext } from '@meteor-it/xpress';
import { useStaticRendering } from 'inferno-mobx';
import { renderToStaticMarkup, renderToString } from 'inferno-server';
import { toJS } from 'mobx';
import { preloadAll } from './preload';
import Rocket from './Rocket';
import { IRocketRouterState } from './router';
import { IDefaultStores, IUninitializedStoreMap } from './stores';

let cachedClientStats = null;
let cachedServerStats = null;

/**
 * As different function to allow tree-shaking
 * @param rocket 
 * @param compiledClientDir Rocket will read zarbis stats to post needed code to client
 * @returns Middleware to use in @meteor-it/xpress
 */
export default function initServer<SM extends IUninitializedStoreMap>(rocket: Rocket<SM>, { compiledClientDir, compiledServerDir }: { compiledClientDir: string, compiledServerDir: string }) {
    useStaticRendering(true);
    return async function (ctx: IRouterContext<any> & XPressRouterContext) {
        // Should be called only on first page load or in SSR, if code isn't shit
        await preloadAll();
        if (cachedClientStats === null || process.env.NODE_ENV === 'development') {
            cachedClientStats = JSON.parse((await readFile(`${compiledClientDir}/stats.json`)).toString());
            cachedServerStats = JSON.parse((await readFile(`${compiledServerDir}/stats.json`)).toString());
        }
        const { params, req, res, query } = ctx;
        let files: string | string[] = cachedClientStats.assetsByChunkName.main;
        if (!Array.isArray(files))
            files = [files];
        let currentState: IRocketRouterState<IDefaultStores> = { drawTarget: null, store: null, redirectTarget: null };
        await (rocket.router as any).route(`/${params['0']}`, ctx => {
            ctx.state = currentState;
            ctx.query = query;
        });
        if (currentState.redirectTarget !== null) {
            res.redirect(currentState.redirectTarget);
            return;
        }

        let nWhenDevelopment = process.env.NODE_ENV === 'development' ? '\n' : ''
        let __html = `${nWhenDevelopment}${process.env.NODE_ENV === 'development' ? '<!-- == SERVER SIDE RENDERED HTML START == -->\n<div id="root">' : ''}${renderToString(currentState.drawTarget)}${process.env.NODE_ENV === 'development' ? '</div>\n<!-- === SERVER SIDE RENDERED HTML END === -->\n' : ''}`;

        let helmet = currentState.store.helmet;

        // Required code
        let neededEntryPointScripts = files.filter(e => !!e).filter(e => e.endsWith('.js'));

        // Loaded code (For preload on client), need to transform 
        // required modules to thier chunks on client
        // Server module id => Server module path => Client module id => Client chunk file 
        const serverModulePathList = currentState.store.helmet.ssrData.preloadModules.map(module => cachedServerStats.ssrData.moduleIdToPath[module]);
        const clientModuleIdList = serverModulePathList.filter(e => !!e).map(module => cachedClientStats.ssrData.modulePathToId[module]);
        const chunkList = [...new Set([].concat(...clientModuleIdList.filter(e => !!e).map(id => cachedClientStats.ssrData.moduleIdToChunkFile[id])).filter(chunk => neededEntryPointScripts.indexOf(chunk) === -1))];

        // No need to render script on server, because:
        //  1. Script will be executed two times (After SSR, and on initial render (After readd))
        //  2. If main script isn't executed, then added script will also won't execute (NoScript)
        //  3. To prevent core monkeypatching (Antipattern)

        // Update unneeded ids for head
        {
            // Skip default meta
            let idx = 3;
            // Remove meta
            for (let i = idx; i < helmet.meta.length + helmet.link.length + idx; i++)
                helmet.ssrData.rht.push(i);
            // Skip removed + title
            idx += helmet.meta.length + helmet.link.length + 1;
            // Remove styles added by helmet
            for (let i = idx; i < helmet.style.length + idx; i++)
                helmet.ssrData.rht.push(i);
            // Skip removed
            idx += helmet.style.length;
            // Remove server added isomorphicStyleLoader styles
            if (currentState.store.isomorphicStyleLoader.styles.size > 0)
                for (let i = idx; i < idx + 1; i++)
                    helmet.ssrData.rht.push(i);
        }
        // Update unneeded ids for body
        {
            // Skip rendered root
            let idx = 1;
            // Remove stored store
            for (let i = idx; i < 1 + idx; i++)
                helmet.ssrData.rbt.push(i);
            // Skip store
            idx += 1;
            // Remove preloaded chunks
            for (let i = idx; i < chunkList.length + idx; i++)
                helmet.ssrData.rbt.push(i);
            // Skip preloaded chunks
            idx += chunkList.length;
            // Remove entry point scripts
            for (let i = idx; i < neededEntryPointScripts.length + idx; i++)
                helmet.ssrData.rbt.push(i);
        }

        // Stringify store for client, also cleanup store from unneeded data
        let safeStore = toJS(currentState.store, { exportMapsAsObjects: true, detectCycles: true });
        let stringStore = `${nWhenDevelopment}${process.env.NODE_ENV === 'development' ? '/* == STORE FOR CLIENT HYDRATION START == */\n' : ''}window.__SSR_STORE__=${JSON.stringify(safeStore, (key, value) => {
            if (value === safeStore.isomorphicStyleLoader)
                return undefined;
            if (value === safeStore.helmet.instances)
                return undefined;
            if (value === safeStore.helmet.ssrData.preloadModules)
                return undefined;
            return value;
        }, process.env.NODE_ENV === 'development' ? 4 : 0)};${nWhenDevelopment}${process.env.NODE_ENV === 'development' ? '/* === STORE FOR CLIENT HYDRATION END === */\n' : ''}`;

        // Finally send rendered data to user
        res.status(200).send(`<!DOCTYPE html>${nWhenDevelopment}${renderToStaticMarkup(<html {...helmet.htmlAttrs.props}>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <meta content="text/html;charset=utf-8" http-equiv="Content-Type" />
                <meta content="utf-8" http-equiv="encoding" />
                {helmet.meta.map(p => <meta {...p.props} />)}
                {helmet.link.map(p => <link {...p.props} />)}
                <title>{currentState.store.helmet.fullTitle}</title>
                {helmet.style.map(p => <style {...p.props} dangerouslySetInnerHTML={{ __html: p.body }} />)}
                {currentState.store.isomorphicStyleLoader.styles.size > 0 ? <style dangerouslySetInnerHTML={{ __html: [...currentState.store.isomorphicStyleLoader.styles].join(nWhenDevelopment) }} /> : null}
            </head>
            <body {...helmet.bodyAttrs.props}>
                <div dangerouslySetInnerHTML={{ __html }} />
                <script async dangerouslySetInnerHTML={{ __html: stringStore }} />
                {chunkList.map(f => <script async src={`/${f}`} />)}
                {neededEntryPointScripts.map(f => <script defer src={`/${f}`} />)}
            </body>
        </html>)}${process.env.NODE_ENV === 'development' ? '\n<!--Meteor.Rocket is running in development mode!-->' : ''}`);
    }
}