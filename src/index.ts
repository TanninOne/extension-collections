import { startEditCollection } from './actions/session';
import persistentReducer from './reducers/persistent';
import sessionReducer from './reducers/session';
import { ICollection } from './types/ICollection';
import { addExtension } from './util/extension';
import { addGameSupport } from './util/gameSupport/index';
import InstallDriver from './util/InstallDriver';
import { cloneCollection, createCollection, makeCollectionId } from './util/transformCollection';
import { bbProm, getUnfulfilledNotificationId } from './util/util';
import AddModsDialog from './views/AddModsDialog';
import CollectionsMainPage from './views/CollectionPage';
// import EditDialog from './views/EditDialog';
import InstallDialog from './views/InstallDialog';

import {
  addCollectionAction, addCollectionCondition,
  alreadyIncluded,
  initFromProfile,
  removeCollectionAction, removeCollectionCondition,
} from './collectionCreate';
import { doExportToFile } from './collectionExport';
import { makeInstall, postprocessCollection, testSupported } from './collectionInstall';
import { MOD_TYPE } from './constants';
import { onCollectionUpdate } from './eventHandlers';
import initIniTweaks from './initweaks';

import * as PromiseBB from 'bluebird';
import memoize from 'memoize-one';
import * as path from 'path';
import * as React from 'react';
import { generate as shortid } from 'shortid';
import { pathToFileURL } from 'url';
import { actions, fs, log, OptionsFilter, selectors, types, util } from 'vortex-api';
import { IExtendedInterfaceProps } from './types/IExtendedInterfaceProps';
import { IGameSupportEntry } from './types/IGameSupportEntry';
import { findModByRef } from './util/findModByRef';

function isEditableCollection(state: types.IState, modIds: string[]): boolean {
  const gameMode = selectors.activeGameId(state);
  const mod = state.persistent.mods[gameMode][modIds[0]];
  if (mod === undefined) {
    return false;
  }
  return util.getSafe(mod.attributes, ['editable'], false);
}

function profileCollectionExists(api: types.IExtensionApi, profileId: string) {
  const state = api.store.getState();
  const gameMode = selectors.activeGameId(state);
  const mods = state.persistent.mods[gameMode];
  return mods[makeCollectionId(profileId)] !== undefined;
}

function onlyLocalRules(rule: types.IModRule) {
  return ['requires', 'recommends'].includes(rule.type)
    && (rule.reference.fileExpression === undefined)
    && (rule.reference.fileMD5 === undefined)
    && (rule.reference.logicalFileName === undefined)
    && (rule.reference.repo === undefined);
}

function makeOnUnfulfilledRules(api: types.IExtensionApi) {
  return (profileId: string, modId: string, rules: types.IModRule[]): PromiseBB<boolean> => {
    const state: types.IState = api.store.getState();

    const profile = selectors.profileById(state, profileId);

    const collection: types.IMod =
      util.getSafe(state.persistent.mods, [profile.gameId, modId], undefined);

    if ((collection !== undefined)
        && (state.persistent.mods[profile.gameId][modId].type === MOD_TYPE)
        && !collection.attributes?.editable) {

      const collectionProfile = Object.keys(state.persistent.profiles)
        .find(iter => makeCollectionId(iter) === modId);

      const notiActions = [{
        title: 'Disable',
        action: dismiss => {
          dismiss();
          api.store.dispatch(actions.setModEnabled(profile.id, modId, false));
        },
      }];

      if (collectionProfile !== undefined) {
        // with local collections that we sync with a profile, we wouldn't be able to
        // installing the missing dependencies because the dependencies are referenced via
        // their local id
        notiActions.unshift({
          title: 'Update',
          action: dismiss => {
            initFromProfile(api, collectionProfile)
              .then(dismiss)
              .catch(err => api.showErrorNotification('Failed to update collection', err));
          },
        });
      } else {
        notiActions.unshift({
          title: 'Resume',
          action: dismiss => {
            driver.start(profile, collection);
            dismiss();
          },
        });
      }

      api.sendNotification({
        id: getUnfulfilledNotificationId(collection.id),
        type: 'info',
        title: 'Collection incomplete',
        message: util.renderModName(collection),
        actions: notiActions,
      });
      return PromiseBB.resolve(true);
    } else {
      return PromiseBB.resolve(false);
    }
  };
}

let driver: InstallDriver;

async function cloneInstalledCollection(api: types.IExtensionApi, collectionId: string) {
  const state = api.getState();
  const gameMode = selectors.activeGameId(state);
  const mods = state.persistent.mods[gameMode];

  const result: types.IDialogResult = await api.showDialog(
    'question',
    'Clone collection "{{collectionName}}"?', {
    text: 'Cloning a collection means you can make edits to the collection in the workshop '
      + 'and share your changes with the community.\n'
      + 'If this collection is your own, your uploads will be revisions of that existing '
      + 'collection, otherwise you will create a new collection associated with your own '
      + 'account.',
    parameters: {
      collectionName: util.renderModName(mods[collectionId]),
    },
  }, [
    { label: 'Cancel' },
    { label: 'Clone' },
  ]);

  if (result.action === 'Clone') {
    const id = makeCollectionId(shortid());
    return cloneCollection(api, gameMode, id, collectionId);
  }
}

function createNewCollection(api: types.IExtensionApi, profile: types.IProfile, name: string) {
  const id = makeCollectionId(shortid());
  createCollection(api, profile.gameId, id, name, []);
  api.sendNotification({
    type: 'success',
    id: 'collection-created',
    title: 'Collection created',
    message: name,
    actions: [
      {
        title: 'Configure',
        action: dismiss => {
          api.store.dispatch(startEditCollection(id));
          dismiss();
        },
      },
    ],
  });
}

function genAttributeExtractor(api: types.IExtensionApi) {
  // tslint:disable-next-line:no-shadowed-variable
  return (modInfo: any, modPath: string): PromiseBB<{ [key: string]: any }> => {
    const collectionId = modInfo.download?.modInfo?.nexus?.ids?.collectionId;
    const revisionId = modInfo.download?.modInfo?.nexus?.ids?.revisionId;
    const revisionNumber = modInfo.download?.modInfo?.nexus?.ids?.revisionNumber;
    const referenceTag = modInfo.download?.modInfo?.referenceTag;

    const result: { [key: string]: any } = {
      collectionId,
      revisionId,
      revisionNumber,
      referenceTag,
    };

    return PromiseBB.resolve(result);
  };
}

let lastRun;

function generateCollectionMap(mods: { [modId: string]: types.IMod })
    : { [modId: string]: types.IMod[] } {

  if (lastRun !== undefined) {
    log('debug', 'mods changed', util.objDiff(lastRun, mods));
  }
  lastRun = mods;
  const collections = Object.values(mods).filter(mod => mod.type === MOD_TYPE);

  const result: { [modId: string]: types.IMod[] } = {};

  collections.forEach(coll => coll.rules.forEach(rule => {
    if (rule.reference.id !== undefined) {
      util.setdefault(result, rule.reference.id, []).push(coll);
    } else {
      const installed = findModByRef(rule.reference, mods);
      if (installed !== undefined) {
        util.setdefault(result, installed.id, []).push(coll);
      }
    }
  }));

  return result;
}

function generateCollectionOptions(mods: { [modId: string]: types.IMod })
    : Array<{ label: string, value: string }> {
  return Object.values(mods)
    .filter(mod => mod.type === MOD_TYPE)
    .map(mod => ({ label: util.renderModName(mod), value: mod.id }));
}

interface ICallbackMap { [cbName: string]: (...args: any[]) => void; }

let collectionChangedCB: () => void;

function register(context: types.IExtensionContext,
                  onSetCallbacks: (callbacks: ICallbackMap) => void) {
  let collectionsCB: ICallbackMap;

  context.registerReducer(['session', 'collections'], sessionReducer);
  context.registerReducer(['persistent', 'collections'], persistentReducer);

  context.registerDialog('collection-install', InstallDialog, () => ({
    driver,
  }));

  context.registerDialog('add-mod-to-collection', AddModsDialog, () => ({
    onAddSelection: (collectionId: string, modIds: string[]) => {
      const state = context.api.getState();
      const gameId = selectors.activeGameId(state);
      const collection = state.persistent.mods[gameId][collectionId];

      modIds.forEach(modId => {
        if (!alreadyIncluded(collection.rules, modId)) {
          context.api.store.dispatch(actions.addModRule(gameId, collectionId, {
            type: 'requires',
            reference: {
              id: modId,
            },
          }));
        }
      });
    },
  }));

  let resetPageCB: () => void;

  context.registerMainPage('collection', 'Collections', CollectionsMainPage, {
    hotkey: 'C',
    group: 'per-game',
    visible: () => selectors.activeGameId(context.api.store.getState()) !== undefined,
    props: () => ({
      driver,
      onSetupCallbacks: (callbacks: ICallbackMap) => {
        collectionsCB = callbacks;
        onSetCallbacks(callbacks);
      },
      onCloneCollection: (collectionId: string) =>
        cloneInstalledCollection(context.api, collectionId),
      onCreateCollection: (profile: types.IProfile, name: string) =>
        createNewCollection(context.api, profile, name),
      resetCB: (cb) => resetPageCB = cb,
    }),
    onReset: () => resetPageCB?.(),
  } as any);

  context.registerModType(MOD_TYPE, 200, () => true,
    () => undefined, () => PromiseBB.resolve(false), {
    name: 'Collection',
    customDependencyManagement: true,
    noConflicts: true,
  } as any);

  const stateFunc: () => types.IState = () => context.api.store.getState();

  const emptyObj = {};

  const collectionsMapFunc = memoize(generateCollectionMap);

  const collectionsMap = () =>
    collectionsMapFunc(
      stateFunc().persistent.mods[selectors.activeGameId(stateFunc())] ?? emptyObj);
  const collectionOptions = memoize(generateCollectionOptions);

  const collectionChanged = new util.Debouncer(() => {
    collectionChangedCB?.();
    return null;
  }, 500);

  const collectionAttribute: types.ITableAttribute<types.IMod> = {
    id: 'collection',
    name: 'Collection',
    description: 'Collection(s) this mod was installed from (if any)',
    icon: 'collection',
    placement: 'both',
    customRenderer: (mod: types.IMod) => {
      const collections = collectionsMap()[mod.id];
      const collectionsString = (collections === undefined)
        ? '' : collections.map(iter => util.renderModName(iter)).join(', ');

      return React.createElement('div', {}, collectionsString);
    },
    calc: (mod: types.IMod) => {
      const collections = collectionsMap()[mod.id];
      return (collections === undefined)
        ? '' : collections.map(iter => iter.id);
    },
    externalData: (onChanged: () => void) => {
      collectionChangedCB = onChanged;
    },
    isToggleable: true,
    edit: {},
    filter: new OptionsFilter((() => {
      const mods = stateFunc().persistent.mods[selectors.activeGameId(stateFunc())] ?? {};
      return collectionOptions(mods);
    }) as any,
      false, false),
    isGroupable: true,
    groupName: (modId: string) =>
      util.renderModName(stateFunc().persistent.mods[selectors.activeGameId(stateFunc())]?.[modId]),
    isDefaultVisible: false,
  };
  context.registerTableAttribute('mods', collectionAttribute);

  context.registerAction('mods-action-icons', 50, 'collection-export', {}, 'Export Collection',
    (modIds: string[]) => {
      const gameMode = selectors.activeGameId(stateFunc());
      doExportToFile(context.api, gameMode, modIds[0]);
    }, (modIds: string[]) => isEditableCollection(stateFunc(), modIds));

  context.registerAction('mods-action-icons', 25, 'collection-edit', {}, 'Edit Collection',
    (modIds: string[]) => {
      context.api.events.emit('show-main-page', 'Collections');
      // have to delay this a bit because the callbacks are only set up once the page
      // is first opened
      setTimeout(() => {
        if ((collectionsCB !== undefined) && (collectionsCB.editCollection !== undefined)) {
          collectionsCB.editCollection(modIds[0]);
        }
      }, 100);
    }, (modIds: string[]) => isEditableCollection(context.api.store.getState(), modIds));

  context.registerAction('mods-action-icons', 75, 'start-install', {}, 'Install Optional Mods...',
    (modIds: string[]) => {
      const profile: types.IProfile = selectors.activeProfile(stateFunc());
      context.api.events.emit('install-recommendations', profile.id, modIds);
    }, (modIds: string[]) => {
      const gameMode = selectors.activeGameId(stateFunc());
      const mod = stateFunc().persistent.mods[gameMode][modIds[0]];
      if (mod === undefined) {
        return false;
      }
      return mod.type === MOD_TYPE;
    });

  context.registerAction('profile-actions', 150, 'highlight-lab', {}, 'Init Collection',
    (profileIds: string[]) => {
      initFromProfile(context.api, profileIds[0])
        .catch(err => context.api.showErrorNotification('Failed to init collection', err));
    }, (profileIds: string[]) => !profileCollectionExists(context.api, profileIds[0]));

  context.registerAction('profile-actions', 150, 'highlight-lab', {}, 'Update Collection',
    (profileIds: string[]) => {
      initFromProfile(context.api, profileIds[0])
        .catch(err => context.api.showErrorNotification('Failed to update collection', err));
    }, (profileIds: string[]) => profileCollectionExists(context.api, profileIds[0]));

  context.registerAction('mods-action-icons', 300, 'collection', {}, 'Add to Collection...',
    (instanceIds: string[]) => addCollectionAction(context.api, instanceIds)
        .then(() => collectionChanged.schedule())
        .catch(err => context.api.showErrorNotification('failed to add mod to collection', err)),
    (instanceIds: string[]) => addCollectionCondition(context.api, instanceIds));
  context.registerAction('mods-multirow-actions', 300, 'collection', {}, 'Add to Collection...',
    (instanceIds: string[]) => addCollectionAction(context.api, instanceIds)
        .then(() => collectionChanged.schedule())
        .catch(err => context.api.showErrorNotification('failed to add mod to collection', err)),
    (instanceIds: string[]) => addCollectionCondition(context.api, instanceIds));

  context.registerAction('mods-action-icons', 300, 'collection', {}, 'Remove from Collection...',
    (instanceIds: string[]) => removeCollectionAction(context.api, instanceIds)
        .then(() => collectionChanged.schedule())
        .catch(err => context.api.showErrorNotification('failed to add mod to collection', err)),
    (instanceIds: string[]) => removeCollectionCondition(context.api, instanceIds));
  context.registerAction('mods-multirow-actions', 300, 'collection', {},
                         'Remove from Collection...',
    (instanceIds: string[]) => removeCollectionAction(context.api, instanceIds)
        .then(() => collectionChanged.schedule())
        .catch(err => context.api.showErrorNotification('failed to add mod to collection', err)),
    (instanceIds: string[]) => removeCollectionCondition(context.api, instanceIds));

  context.registerAttributeExtractor(100, genAttributeExtractor(context.api));

  context.registerInstaller('collection', 5,
                            bbProm(testSupported), bbProm(makeInstall(context.api)));

  context['registerGameSpecificCollectionsData'] = ((gameSupportEntry: IGameSupportEntry) => {
    try {
      addGameSupport(gameSupportEntry);
    } catch (err) {
      context.api.showErrorNotification('Failed to add game specific data to collection', err);
    }
  });

  context['registerCollectionFeature'] =
    (id: string,
     generate: (gameId: string, includedMods: string[]) => Promise<any>,
     parse: (gameId: string, collection: any) => Promise<void>,
     title: (t: types.TFunction) => string,
     condition?: (state: types.IState, gameId: string) => boolean,
     editComponent?: React.ComponentType<IExtendedInterfaceProps>) =>  {
      addExtension({ id, generate, parse, condition, title, editComponent });
    };

  context.registerAPI('addGameSpecificCollectionsData',
    (gameSupportEntry: IGameSupportEntry, cb?: (err: Error) => void) => {
    try {
      addGameSupport(gameSupportEntry);
    } catch (err) {
      if (cb) {
        cb(err);
      } else {
        context.api.showErrorNotification('Failed to add game specific data to collection', err);
      }
    }
  }, { minArguments: 1 });
}

function once(api: types.IExtensionApi, collectionsCB: () => ICallbackMap) {
  const { store } = api;

  driver = new InstallDriver(api);

  driver.onUpdate(() => {
    // currently no UI associated with the start step
    if (driver.step === 'start') {
      driver.continue();
    }
  });

  api.setStylesheet('modpacks', path.join(__dirname, 'style.scss'));

  const state: () => types.IState = () => store.getState();

  interface IModsDict { [gameId: string]: { [modId: string]: types.IMod }; }

  api.onStateChange(['persistent', 'mods'], (prev: IModsDict, cur: IModsDict) => {
    const gameMode = selectors.activeGameId(api.getState());
    const prevG = prev[gameMode] ?? {};
    const curG = cur[gameMode] ?? {};
    const allIds =
      Array.from(new Set([].concat(Object.keys(prev[gameMode]), Object.keys(cur[gameMode]))));
    const changed = allIds.find(modId =>
      ((prevG[modId]?.type === MOD_TYPE) || (curG[modId]?.type === MOD_TYPE))
      && (prevG[modId]?.attributes?.customFileName
          !== curG[modId]?.attributes?.customFileName));
    if (changed !== undefined) {
      collectionChangedCB?.();
    }
  });

  api.events.on('did-install-mod', (gameId: string, archiveId: string, modId: string) => {
    // automatically enable collections once they're installed
    const profileId = selectors.lastActiveProfileForGame(state(), gameId);
    const profile = selectors.profileById(state(), profileId);
    if (profile === undefined) {
      return;
    }
    const mod = util.getSafe(state().persistent.mods, [gameId, modId], undefined);
    if ((mod !== undefined) && (mod.type === MOD_TYPE)) {
      driver.query(profile, mod);
    }
  });

  api.events.on('did-install-dependencies',
    async (profileId: string, modId: string, recommendations: boolean) => {
      const profile = selectors.profileById(state(), profileId);
      const stagingPath = selectors.installPathForGame(state(), profile.gameId);
      const mods = state().persistent.mods[profile.gameId];
      const mod = mods[modId];
      if ((mod !== undefined) && (mod.type === MOD_TYPE)) {
        try {
          const collectionData = await fs.readFileAsync(
            path.join(stagingPath, mod.installationPath, 'collection.json'),
            { encoding: 'utf-8' });
          const collection: ICollection = JSON.parse(collectionData);
          postprocessCollection(api, profile, collection, mods);
        } catch (err) {
          log('info', 'Failed to apply mod rules from collection. This is normal if this is the '
            + 'platform where the collection has been created.');
        }
      }
    });

  api.onAsync('unfulfilled-rules', makeOnUnfulfilledRules(api));
  api.events.on('collection-update', onCollectionUpdate(api));

  api.events.on('did-finish-download', (dlId: string, outcome: string) => {
    if (outcome === 'finished') {
      const download: types.IDownload = state().persistent.downloads.files[dlId];
      if (download === undefined) {
        return;
      }
    }
  });

  api.events.on('did-download-collection', async (dlId: string) => {
    try {
      const dlInfo: types.IDownload =
        util.getSafe(state().persistent.downloads.files, [dlId], undefined);
      const profile = selectors.activeProfile(state());
      if (!dlInfo.game.includes(profile.gameId)) {
        log('info', 'Collection downloaded for a different game than is being managed',
            { gameMode: profile.gameId, game: dlInfo.game });
        api.sendNotification({
          message: 'The collection you downloaded is for a different game and thus '
                 + 'can\'t be installed right now.',
          type: 'info',
        });

        // the collection was for a different game, can't install it now
        return;
      } else {
        // once this is complete it will automatically trigger did-install-mod
        // which will then start the ui for the installation process
        await util.toPromise<string>(cb => api.events.emit('start-install-download', dlId, {}, cb));
      }
    } catch (err) {
      if (!(err instanceof util.UserCanceled)) {
        api.showErrorNotification('Failed to add collection', err, {
          allowReport: !(err instanceof util.ProcessCanceled),
        });
      }
    }
  });

  api.events.on('view-collection', (collectionId: string) => {
    api.events.emit('show-main-page', 'Collections');
    // have to delay this a bit because the callbacks are only set up once the page
    // is first opened
    setTimeout(() => {
      collectionsCB().viewCollection?.(collectionId);
    }, 100);
  });

  api.events.on('edit-collection', (collectionId: string) => {
    api.events.emit('show-main-page', 'Collections');
    // have to delay this a bit because the callbacks are only set up once the page
    // is first opened
    setTimeout(() => {
      collectionsCB().editCollection?.(collectionId);
    }, 100);
  });

  util.installIconSet('collections', path.join(__dirname, 'icons.svg'))
    .catch(err => api.showErrorNotification('failed to install icon set', err));

  const iconPath = path.join(__dirname, 'collectionicon.svg');
  document.getElementById('content').style
    .setProperty('--collection-icon', `url(${pathToFileURL(iconPath).href})`);
}

function init(context: types.IExtensionContext): boolean {
  let collectionsCB: ICallbackMap;

  register(context, (callbacks: ICallbackMap) => collectionsCB = callbacks);

  initIniTweaks(context);

  context.once(() => {
    once(context.api, () => collectionsCB);
  });
  return true;
}

export default init;
