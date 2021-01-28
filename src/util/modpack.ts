import { MOD_TYPE } from '../constants';
import { IModPack, IModPackAttributes, IModPackInfo, IModPackMod,
         IModPackModRule, IModPackSourceInfo } from '../types/IModPack';

import { findModByRef } from './findModByRef';
import { generateGameSpecifics } from './gameSupport';

import * as _ from 'lodash';
import * as path from 'path';
import * as semver from 'semver';
import { generate as shortid } from 'shortid';
import turbowalk, { IEntry } from 'turbowalk';
import { actions, fs, log, selectors, types, util } from 'vortex-api';
import { fileMD5 } from 'vortexmt';

export const LOGO_NAME: string = 'logo.jpg';

const fileMD5Async = (fileName: string) => new Promise((resolve, reject) => {
  fileMD5(fileName, (err: Error, result: string) => (err !== null) ? reject(err) : resolve(result));
});

function sanitizeExpression(fileName: string): string {
  // drop extension and anything like ".1" or " (1)" at the end which probaby
  // indicates duplicate downloads (either in our own format or common browser
  // style)
  return path.basename(fileName, path.extname(fileName))
    .replace(/\.\d+$/, '')
    .replace(/ \(\d+\)$/, '');
}

function toInt(input: string | number | undefined | null) {
  if (!input) {
    return 0;
  }

  if (typeof(input) === 'string') {
    return parseInt(input, 10);
  }

  return input;
}

function deduceSource(mod: types.IMod,
                      sourceInfo: IModPackSourceInfo,
                      versionMatcher: string)
                      : IModPackSourceInfo {
  const res: Partial<IModPackSourceInfo> = (sourceInfo !== undefined)
    ? {...sourceInfo}
    : { type: 'nexus' };

  if (res.type === 'nexus') {
    if (mod.attributes?.source !== 'nexus') {
      throw new Error(`"${util.renderModName(mod)}" doesn't have Nexus as its source`);
    }
    const modId = (mod.type === MOD_TYPE) ? mod.attributes?.collectionId : mod.attributes?.modId;
    const fileId = (mod.type === MOD_TYPE) ? mod.attributes?.revisionId : mod.attributes?.fileId;
    if ((modId === undefined) || (fileId === undefined)) {
      throw new Error(`"${mod.id}" is missing mod id or file id`);
    }

    res.modId = toInt(modId)
    res.fileId = toInt(fileId);
  }

  const assign = (obj: any, key: string, value: any) => {
    if (obj[key] === undefined) {
      obj[key] = value;
    }
  };

  assign(res, 'md5', mod.attributes?.fileMD5);
  assign(res, 'fileSize', mod.attributes?.fileSize);
  assign(res, 'logicalFilename', mod.attributes?.logicalFileName);
  if (sourceInfo?.updatePolicy !== undefined) {
    assign(res, 'updatePolicy', sourceInfo.updatePolicy);
  } else {
    if (versionMatcher === '*') {
      assign(res, 'updatePolicy', 'latest');
    } else if ((versionMatcher === undefined)
               || versionMatcher.endsWith('+prefer')) {
      assign(res, 'updatePolicy', 'prefer');
    } else {
      assign(res, 'updatePolicy', 'exact');
      assign(res, 'version', versionMatcher);
    }
  }

  if ((res.md5 === undefined)
      && (res.logicalFilename === undefined)
      && (res.fileExpression === undefined)) {
    assign(res, 'fileExpression', sanitizeExpression(mod.attributes?.fileName));
  }

  return res as IModPackSourceInfo;
}

/*
export function initModPackMod(input: types.IMod): IModPackMod {
  return {
    name: util.renderModName(input),
    version: util.getSafe(input, ['attributes', 'version'], ''),
    optional: false,
    domain_name: util.getSafe(input, ['attributes', 'downloadGame'], undefined),
    source: deduceSource(input),
  };
}
*/

export function generateModPack(info: IModPackInfo,
                                mods: IModPackMod[],
                                modRules: IModPackModRule[]): IModPack {
  return {
    info,
    mods,
    modRules,
  };
}

async function rulesToModPackMods(rules: types.IModRule[],
                                  mods: { [modId: string]: types.IMod },
                                  stagingPath: string,
                                  gameId: string,
                                  modpackInfo: IModPackAttributes,
                                  onProgress: (percent: number, text: string) => void,
                                  onError: (message: string, replace: any) => void)
                                  : Promise<IModPackMod[]> {
  let total = rules.length;

  let finished = 0;

  const result: IModPackMod[] = await Promise.all(rules.map(async (rule, idx) => {
    const mod = (rule.reference.id !== undefined)
      ? mods[rule.reference.id]
      : findModByRef(rule.reference, mods);

    if ((mod === undefined) || (mod.type === MOD_TYPE)) {
      // don't include the modpack itself (or any other modpack for that matter,
      // nested collections aren't allowed)
      --total;
      return undefined;
    }

    const modName = util.renderModName(mod, { version: false });
    try {
      // This call is relatively likely to fail to do it before the hash calculation to
      // save the user time in case it does fail
      const source = deduceSource(mod,
                                  modpackInfo['source']?.[mod.id],
                                  rule.reference.versionMatch);

      let hashes: any;
      let choices: any;

      let entries: IEntry[] = [];

      const installMode: string = modpackInfo?.['installMode']?.[mod.id] ?? 'fresh';

      if (installMode === 'clone') {
        const modPath = path.join(stagingPath, mod.installationPath);
        await turbowalk(modPath, async input => {
          entries = [].concat(entries, input);
        }, {});

        hashes = await Promise.all(entries
          .filter(iter => !iter.isDirectory)
          .map(async iter => ({
            path: path.relative(modPath, iter.filePath),
            md5: await fileMD5Async(iter.filePath),
          })));

        onProgress(undefined, modName);

        ++finished;
      } else if (installMode === 'choices') {
        choices = mod?.attributes?.installerChoices;
        --total;
      } else {
        --total;
      }

      onProgress(Math.floor((finished / total) * 100), modName);

      const res: IModPackMod = {
        name: modName,
        version: mod.attributes?.version ?? '1.0.0',
        optional: rule.type === 'recommends',
        domainName: mod.attributes?.downloadGame ?? gameId,
        source,
        hashes,
        choices,
        instructions: modpackInfo.instructions?.[mod.id],
        author: mod.attributes?.author,
        details: {},
      };

      if (mod.type !== '') {
        res.details['type'] = mod.type;
      }
      return res;
    } catch (err) {
      --total;

      onError('failed to pack "{{modName}}": {{error}}', {
        modName, error: err.message,
      });

      return undefined;
    }
  }));

  return result.filter(mod => (mod !== undefined) && (Object.keys(mod.source).length > 0));
}

export function makeBiDirRule(mod: types.IMod, rule: types.IModRule): IModPackModRule {
  if (rule === undefined) {
    return undefined;
  }

  const source: types.IModReference = (util as any).makeModReference(mod);

  return {
    type: rule.type,
    reference: rule.reference,
    source,
  };
}

function makeTransferrable(mods: { [modId: string]: types.IMod },
                           modpack: types.IMod,
                           rule: types.IModRule): types.IModRule {
  if ((rule.reference.fileMD5 !== undefined)
      || (rule.reference.logicalFileName !== undefined)
      || (rule.reference.fileExpression !== undefined)) {
    // ok unmodified
    return rule;
  }
  if (rule.reference.id === undefined) {
    // rule unusable
    log('warn', 'invalid rule couldn\'t be included in the collection', JSON.stringify(rule));
    return undefined;
  }

  // a rule that doesn't contain any of the above markers will likely not be able to match
  // anything on a different system

  const mod = findModByRef(rule.reference, mods);

  if (mod === undefined) {
    log('warn', 'mod enabled in collection isn\'t installed', JSON.stringify(rule));
    return undefined;
  }

  const newRef: types.IModReference = util.makeModReference(mod);

  // ok, this gets a bit complex now. If the referenced mod gets updated, also make sure
  // the rules referencing it apply to newer versions
  const mpRule = modpack.rules.find(iter => util.testModReference(mod, iter.reference));
  if ((mpRule !== undefined) && (mpRule.reference.versionMatch === '*')) {
    newRef.versionMatch = '*';
  }

  return {
    type: rule.type,
    fileList: (rule as any).fileList,
    comment: rule.comment,
    reference: newRef,
  } as any;
}

function extractModRules(rules: types.IModRule[],
                         modpack: types.IMod,
                         mods: { [modId: string]: types.IMod },
                         onError: (message: string, replace: any) => void): IModPackModRule[] {
  return rules.reduce((prev: IModPackModRule[], rule: types.IModRule) => {
    const mod = mods[rule.reference.id];
    if (mod === undefined) {
      onError('Not packaging mod that isn\'t installed: "{{id}}"', { id: rule.reference.id });
      return prev;
    } else if (mod.id === modpack.id) {
      return prev;
    }

    return [].concat(prev, (mod.rules || []).map((input: types.IModRule): IModPackModRule =>
      makeBiDirRule(mod, makeTransferrable(mods, modpack, input))));
  }, [])
  // throw out rules that couldn't be converted
  .filter(rule => rule !== undefined);
}

export function modPackModToRule(mod: IModPackMod): types.IModRule {
  const downloadHint = ['manual', 'browse', 'direct'].includes(mod.source.type)
    ? {
      url: mod.source.url,
      instructions: mod.source.instructions,
      mode: mod.source.type,
    }
    : undefined;

  let versionMatch = `>=${semver.coerce(mod.version)?.version ?? '0.0.0'}+prefer`;
  if (mod.source.updatePolicy === 'exact') {
    versionMatch = mod.version;
  } else if (mod.source.updatePolicy === 'latest') {
    versionMatch = '*';
  }
  const reference: types.IModReference = {
    description: mod.name,
    fileMD5: mod.source.md5,
    gameId: mod.domainName,
    fileSize: mod.source.fileSize,
    versionMatch,
    logicalFileName: mod.source.logicalFilename,
    fileExpression: mod.source.fileExpression,
  };

  if (downloadHint !== undefined) {
    // if the mod gets downloaded from a foreign source it will be next to impossible
    // to later match the actual download against the reference.
    // To help with that we generate a random tag that needs to be carried over to every
    // download downloaded from this rule and every mod installed from that so that
    // we don't re-download the same file again and again.
    reference['tag'] = shortid();
  }

  if (mod.source.type === 'nexus') {
    reference['repo'] = {
      repository: 'nexus',
      gameId: mod.domainName,
      modId: mod.source.modId.toString(),
      fileId: mod.source.fileId.toString(),
    };
  }

  return {
    type: mod.optional ? 'recommends' : 'requires',
    reference,
    fileList: mod.hashes,
    installerChoices: mod.choices,
    downloadHint,
    extra: {
      author: mod.author,
      type: mod.details.type,
      name: mod.name,
      instructions: mod.instructions,
    },
  } as any;
}

export async function modToPack(state: types.IState,
                                gameId: string,
                                stagingPath: string,
                                modpack: types.IMod,
                                mods: { [modId: string]: types.IMod },
                                onProgress: (percent?: number, text?: string) => void,
                                onError: (message: string, replace: any) => void)
                                : Promise<IModPack> {
  if (selectors.activeGameId(state) !== gameId) {
    // this would be a bug
    return Promise.reject(new Error('Can only export collection for the active profile'));
  }

  const modRules = extractModRules(modpack.rules, modpack, mods, onError);

  const includedMods = (modpack.rules as types.IModRule[])
    .map(rule => {
      if (rule.reference.id !== undefined) {
        return rule.reference.id;
      } else {
        const mod = findModByRef(rule.reference, mods);
        if (mod !== undefined) {
          return mod.id;
        }
        return undefined;
      }
    })
    .filter(id => id !== undefined);

  const missing = includedMods.find(modId => mods[modId] === undefined);
  if (missing !== undefined) {
    return Promise.reject(new Error('Can only export collections that are fully installed'));
  }

  const gameSpecific = await generateGameSpecifics(state, gameId, stagingPath, includedMods, mods);

  const modpackInfo: IModPackInfo = {
    // collection_id: util.getSafe(modpack.attributes, ['collectionId'], undefined),
    author: modpack.attributes?.author ?? 'Anonymous',
    authorUrl: modpack.attributes?.authorURL ?? '',
    name: util.renderModName(modpack),
    // version: util.getSafe(modpack.attributes, ['version'], '1.0.0'),
    description: modpack.attributes?.shortDescription ?? '',
    domainName: gameId,
  };

  const res: IModPack = {
    info: modpackInfo,
    mods: await rulesToModPackMods(modpack.rules, mods, stagingPath, gameId,
                                   modpack.attributes?.modpack ?? {},
                                   onProgress, onError),
    modRules,
    ...gameSpecific,
  };

  return res;
}

function createRulesFromProfile(profile: types.IProfile,
                                mods: {[modId: string]: types.IMod},
                                existingRules: types.IModRule[],
                                existingId: string): types.IModRule[] {
  return Object.keys(profile.modState)
    .filter(modId => profile.modState[modId].enabled
                  && (mods[modId] !== undefined)
                  && (modId !== existingId)
                  // no nested collections allowed
                  && (mods[modId].type !== MOD_TYPE)
                  && (mods[modId].attributes['generated'] !== true))
    .map(modId => {
      // don't forget what we set up regarding version matching
      let versionMatch: string;

      const oldRule = existingRules
        .find(iter => util.testModReference(mods[modId], iter.reference));
      if ((oldRule !== undefined) && (oldRule.reference.versionMatch !== undefined)) {
        versionMatch = (oldRule.reference.versionMatch === '*')
          ? '*'
          : mods[modId].attributes.version;
      }

      return {
        type: 'requires',
        reference: {
          id: modId,
          versionMatch,
        },
      } as any;
    });
}

export function makeModpackId(baseId: string): string {
  return `vortex_collection_${baseId}`;
}

export async function createModpack(api: types.IExtensionApi,
                                    gameId: string,
                                    id: string,
                                    name: string,
                                    rules: types.IModRule[]) {
  const state: types.IState = api.store.getState();

  const mod: types.IMod = {
    id,
    type: MOD_TYPE,
    state: 'installed',
    attributes: {
      name,
      version: '1.0.0',
      installTime: new Date(),
      author: state.persistent['nexus']?.userInfo?.name ?? 'Anonymous',
      editable: true,
    },
    installationPath: id,
    rules,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      api.events.emit('create-mod', gameId, mod, (error: Error) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

    const deployPath = selectors.installPathForGame(state, gameId);
    await fs.copyAsync(path.join(__dirname, 'fallback_tile.jpg'), path.join(deployPath, id, LOGO_NAME))
      .catch(err => api.showErrorNotification('Failed to install default modpack logo', err));
  } catch (err) {
    api.showErrorNotification('Failed to create collection', err);
  }
}

function updateModpack(api: types.IExtensionApi,
                       gameId: string,
                       mod: types.IMod,
                       newRules: types.IModRule[]) {
  api.store.dispatch(actions.setModAttribute(gameId, mod.id, 'editable', true));

  const removedRules: types.IModRule[] = [];
  // remove rules not found in newRules
  mod.rules.forEach(rule => {
    if (newRules.find(iter => _.isEqual(rule, iter)) === undefined) {
      removedRules.push(rule);
      api.store.dispatch(actions.removeModRule(gameId, mod.id, rule));
    }
  });
  // add rules not found in the old list
  newRules.forEach(rule => {
    if (mod.rules.find(iter => _.isEqual(rule, iter)) === undefined) {
      api.store.dispatch(actions.addModRule(gameId, mod.id, rule));
    }
  });
}

export async function createModpackFromProfile(api: types.IExtensionApi,
                                               profileId: string)
                                               : Promise<{ id: string, name: string, updated: boolean }> {
  const state: types.IState = api.store.getState();
  const profile = state.persistent.profiles[profileId];

  const id = makeModpackId(profileId);
  const name = `Collection: ${profile.name}`;
  const mod: types.IMod = state.persistent.mods[profile.gameId]?.[id];

  const rules = createRulesFromProfile(profile, state.persistent.mods[profile.gameId],
                                       (mod !== undefined) ? mod.rules : [], mod.id);

  if (mod === undefined) {
    await createModpack(api, profile.gameId, id, name, rules);
  } else {
    updateModpack(api, profile.gameId, mod, rules);
  }

  return { id, name, updated: mod !== undefined };
}
