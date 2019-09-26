import { IModPackSourceInfo, SourceType } from '../types/IModPack';
import findModByRef from '../util/findModByRef';

import I18next from 'i18next';
import * as _ from 'lodash';
import * as React from 'react';
import { ComponentEx, Icon, ITableRowAction, Table, tooltip, types, Usage, util } from 'vortex-api';

export interface IModsPageProps {
  t: I18next.TFunction;
  modpack: types.IMod;
  mods: { [modId: string]: types.IMod };
  onSetModVersion: (modId: string, version: 'exact' | 'newest') => void;
  onAddRule: (rule: types.IModRule) => void;
  onRemoveRule: (rule: types.IModRule) => void;
  onSetModpackAttribute: (path: string[], value: any) => void;
}

interface IModEntry {
  rule: types.IModRule;
  mod: types.IMod;
}

interface IModsPageState {
  entries: { [modId: string]: IModEntry };
  problems: { [modId: string]: string[] };
}

type IProps = IModsPageProps;

const SOURCES = {
  nexus: 'Nexus Mods',
  direct: 'Direct download',
  browse: 'Browse a website',
  pack: 'Bundle with modpack',
  manual: 'Manual',
};

const INSTALL_MODES = {
  fresh: 'Fresh Install',
  choices: 'Same Installer Options',
  clone: 'Replicate',
};

class ModsPage extends ComponentEx<IProps, IModsPageState> {
  private mLang: string;
  private mCollator: Intl.Collator;

  private mColumns: Array<types.ITableAttribute<IModEntry>> = [
    {
      id: 'name',
      name: 'Mod Name',
      description: 'Mod Name',
      calc: (entry: IModEntry) => util.renderModName(entry.mod),
      placement: 'table',
      edit: {},
      isDefaultSort: true,
      isSortable: true,
      sortFunc: (lhs: string, rhs: string, locale: string): number => {
        if ((this.mCollator === undefined) || (locale !== this.mLang)) {
          this.mLang = locale;
          this.mCollator = new Intl.Collator(locale, { sensitivity: 'base' });
        }
        return this.mCollator.compare(lhs, rhs);
      },
    }, {
      id: 'highlight',
      name: '',
      description: 'Mod Highlights',
      customRenderer: (mod: IModEntry) => {
        const color = util.getSafe(mod.mod.attributes, ['color'], '');
        const icon = util.getSafe(mod.mod.attributes, ['icon'], '');
        const hasProblem = (this.state.problems[mod.mod.id] !== undefined)
                        && (this.state.problems[mod.mod.id].length > 0);

        if (!color && !icon  && !hasProblem) {
          return null;
        }
        return (
          <>
            <Icon
              className={'highlight-base ' + (color !== '' ? color : 'highlight-default')}
              name={icon !== '' ? icon : 'highlight'}
            />
            {hasProblem ? (
              <tooltip.Icon
                name='incompatible'
                tooltip={this.state.problems[mod.mod.id].join('\n')}
              />
            ) : null}
          </>
        );
      },
      calc: (mod: IModEntry) => {
        const color = util.getSafe(mod.mod.attributes, ['color'], '');
        const icon = util.getSafe(mod.mod.attributes, ['icon'], '');
        const problems = this.state.problems[mod.mod.id] || [];

        return `${color} - ${icon} - ${problems.join(',')}`;
      },
      placement: 'table',
      edit: {},
    }, {
      id: 'version',
      name: 'Version',
      description: 'The version to install',
      calc: (mod: IModEntry) => {
        if ((mod.rule.reference.versionMatch === undefined)
            || (mod.rule.reference.versionMatch === '*')) {
          return 'Latest available update';
        } else {
          return 'Exactly this version';
        }
      },
      placement: 'table',
      edit: {
        inline: true,
        actions: false,
        choices: () => [
          { key: 'exact', text: 'Exactly this version' },
          { key: 'newest', text: 'Latest available update' }],
        onChangeValue: (source: IModEntry, value: any) => {
          this.props.onRemoveRule(source.rule);
          const newRule = _.cloneDeep(source.rule);
          newRule.reference.versionMatch = (value === 'exact')
            ? source.mod.attributes['version']
            : '*';
          this.props.onAddRule(newRule);
        },
      },
    }, {
      id: 'required',
      name: 'Required',
      description: 'Whether the entire mod pack will fail if this mod is missingü',
      calc: (mod: IModEntry) => {
        return mod.rule.type === 'requires'
          ? 'Required'
          : 'Optional';
      },
      placement: 'table',
      edit: {
        inline: true,
        actions: false,
        choices: () => [
          { key: 'required', text: 'Required' },
          { key: 'optional', text: 'Optional' },
        ],
        onChangeValue: (source: IModEntry, value: any) => {
          this.props.onRemoveRule(source.rule);
          const newRule = _.cloneDeep(source.rule);
          newRule.type = value === 'optional' ? 'recommends' : 'requires';
          this.props.onAddRule(newRule);
        },
      },
    }, {
      id: 'install-type',
      name: 'Install',
      description: 'How the mod should be installed on the user system',
      calc: (entry: IModEntry) => {
        const { modpack } = this.props;
        const installMode =
          util.getSafe(modpack, ['attributes', 'modpack', 'installMode', entry.mod.id], 'fresh');
        return INSTALL_MODES[installMode];
      },
      placement: 'table',
      help: 'If set to "Fresh Install" the mod will simply be installed fresh on the users system, '
          + 'installer (if applicable) and everything.\n'
          + 'If set to "Replicate" Vortex will try to replicate your exact setup for this mod. '
          + 'This does not bundle the mod itself but the list of files to install and patches if '
          + 'necessary. This may increase the size of the mod pack and the time it takes to '
          + 'export it considerably.',
      edit: {
        inline: true,
        actions: false,
        choices: () => Object.keys(INSTALL_MODES).map(key => ({ key, text: INSTALL_MODES[key] })),
        onChangeValue: (source: IModEntry, value: any) => {
          this.props.onSetModpackAttribute(['installMode', source.mod.id], value);
        },
      },
    }, {
      id: 'source',
      name: 'Source',
      description: 'How the user acquires the mod',
      calc: (entry: IModEntry) => {
        const { modpack } = this.props;
        const type = util.getSafe(modpack,
                                  ['attributes', 'modpack', 'source', entry.mod.id, 'type'],
                                  'nexus');
        return SOURCES[type];
      },
      placement: 'table',
      edit: {
        inline: true,
        actions: false,
        choices: () => Object.keys(SOURCES).map(key => ({ key, text: SOURCES[key] })),
        onChangeValue: (source: IModEntry, value: any) => {
          this.querySource(source.mod.id, value);
        },
      },
    }, {
      id: 'edit-source',
      placement: 'table',
      edit: {},
      calc: (entry: IModEntry) => {
        const { modpack } = this.props;
        const type = util.getSafe(modpack,
                                  ['attributes', 'modpack', 'source', entry.mod.id, 'type'],
                                  'nexus');
        return SOURCES[type];
      },
      customRenderer: (entry: IModEntry) => {
        const { t, modpack } = this.props;
        const type = util.getSafe(modpack,
                                  ['attributes', 'modpack', 'source', entry.mod.id, 'type'],
                                  'nexus');
        return (
          <tooltip.IconButton
            icon='edit'
            disabled={['nexus', 'pack'].indexOf(type) !== -1}
            tooltip={t('Edit Source')}
            data-modid={entry.mod.id}
            onClick={this.onQuerySource}
          />
        );
      },
    },
  ];

  private mActions: ITableRowAction[] = [
    {
      title: 'Attach Instructions',
      icon: 'edit',
      singleRowAction: true,
      action: (instanceId: string) => null,
    },
    {
      title: 'Remove',
      icon: 'delete',
      singleRowAction: true,
      multiRowAction: true,
      action: (instanceIds: string[]) => {
        instanceIds.forEach(id => {
          this.props.onRemoveRule(this.state.entries[id].rule);
          delete this.nextState.entries[id];
        });
      },
    },
  ];

  constructor(props: IProps) {
    super(props);

    const entries = this.generateEntries(props);
    this.initState({
      entries,
      problems: this.checkProblems(props, entries),
    });
  }

  public componentWillReceiveProps(newProps: IProps) {
    if ((newProps.mods !== this.props.mods)
        || (newProps.modpack !== this.props.modpack)) {
      const entries = this.generateEntries(newProps);
      this.nextState.entries = entries;
      this.nextState.problems = this.checkProblems(newProps, entries);
    }
  }

  public render(): React.ReactNode {
    const { t } = this.props;
    const { entries } = this.state;

    return (
      <div className='modpack-mods-container'>
      <Table
        tableId='modpack-mods'
        data={entries}
        staticElements={this.mColumns}
        actions={this.mActions}
        showDetails={false}
      />
      <Usage infoId='modpack-mods'>
        <p>{t('Here you can configure which mods to install and how.')}</p>
        <p>{t('Version: Choose whether the modpack will install exactly the version you '
           + 'have yourself or whatever is current on Nexus Mods.')}</p>
        <p>{t('Required: Select whether the user has to install the mod or whether it\'s just '
           + 'a recommendation.')}</p>
        <p>{t('Install: "Fresh Install" will install the mod as Vortex would usually do, installer '
           + 'dialog and everything. "Replicate" will extract only the files you have extracted '
           + 'yourself, in exactly the same location. This basically ensures the user gets the '
           + 'same options as you without having to pick them but it only works when you have '
           + 'selected "Exact version" in the Version column. It will also considerably increase '
           + 'the time it takes to build the pack.')}</p>
        <p>{t('Source: Decides how the user downloads the mod. "Nexus Mods" is easiest, use the '
           + 'other options when the mod in only hosted on a different source. '
           + 'The options also include "pack" which bundles the mod directly into the mod pack. '
           + 'Do this only for stuff created during setup (e.g. generated LODs, '
           + 'customized configuration files and such). '
           + 'You must not include any material you don\'t hold the copyright to. '
           + 'Also Do not provide direct download links unless you have express permission to '
           + 'do so.')}
         </p>
      </Usage>
      </div>
    );
  }

  private generateEntries(props: IProps) {
    const { modpack, mods } = props;

    if ((modpack === undefined) || (modpack.rules === undefined)) {
      return {};
    }

    return Object.values(modpack.rules)
      .filter(rule => ['requires', 'recommends'].indexOf(rule.type) !== -1)
      .reduce((prev, rule) => {
        const mod = findModByRef(rule.reference, mods);
        if (mod !== undefined) {
          prev[mod.id] = { rule, mod };
        }
        return prev;
      }, {});
  }

  private checkProblems(props: IProps,
                        entries: { [modId: string]: IModEntry })
                        : { [modId: string]: string[] } {
    return Object.values(entries).reduce((prev, entry) => {
      prev[entry.mod.id] = this.updateProblems(props, entry);
      return prev;
    }, {});
  }

  private updateProblems(props: IProps, mod: IModEntry): string[] {
    const { t, modpack } = props;

    const res: string[] = [];

    const source: string =
      util.getSafe(modpack, ['attributes', 'modpack', 'source', mod.mod.id, 'type'], 'nexus');
    const installMode: string =
      util.getSafe(modpack, ['attributes', 'modpack', 'installMode', mod.mod.id], 'fresh');

    if (mod.rule.reference.versionMatch === '*') {
      if (installMode === 'clone') {
        res.push(t('"Replicate" install can only be used when installing '
                  + 'a specific version of a mod. This will definitively break '
                  + 'as soon as the mod gets updated.'));
      } else if (installMode === 'choices') {
        res.push(t('Installing with "Same choices options" may break if the mod gets updated, '
                 + 'you may want to switch to "Exactly this version" to be safe.'));
      }
    }

    if (source === 'pack') {
      res.push(t('Mods are copyright protected, only pack mods if you are sure you '
               + 'have the right to do so, e.g. if it\'s dynamically generated content, '
               + 'if it\'s your own mod or if you have (written) permission to do so.'));
    } else if (source === 'direct') {
      res.push(t('Most websites don\'t allow direct downloads, Plese make sure you are '
               + 'allowed to use direct links to the specified page.'));
    }

    if ((installMode === 'choices')
        && (util.getSafe(mod.mod, ['attributes', 'installerChoices'], undefined) === undefined)) {
      res.push(t('The installer choices for this mod haven\'t been saved. '
               + 'This currently only works with xml-based fomods installed with '
               + 'Vortex 1.1.0 or later. '
               + 'You may have to reinstall the mod for this to work.'));
    }

    if (mod.rule.reference.versionMatch === '') {
      res.push(t('The mod has no version number set. This isn\'t strictly necessary, we use the '
               + 'file id to identify the exact version but for the purpose of informing the '
               + 'user it would be nicer if a version was specified. '
               + '(Please don\'t forget to update the modpack)'));
    }

    return res;
  }

  private querySource(modId: string, type: SourceType) {
    const { modpack } = this.props;
    const src: IModPackSourceInfo = util.getSafe(modpack,
      ['attributes', 'modpack', 'source', modId], { type });
    const input: types.IInput[] = [];

    if (['direct', 'browse'].indexOf(type) !== -1) {
      input.push({ id: 'url', type: 'url', label: 'URL', value: src.url });
    }

    if (['browse', 'manual'].indexOf(type) !== -1) {
      input.push({
        id: 'instructions', type: 'text', label: 'Instructions',
        value: src.instructions,
      });
    }

    if (input.length > 0) {
      // query details for direct/browse/manual
      this.context.api.showDialog('question',
        'Please provide information the user needs to find the mod', {
        input,
      }, [
        { label: 'Save' },
      ]).then((result => {
        this.props.onSetModpackAttribute(['source', modId], {
          type,
          url: result.input.url,
          instructions: result.input.instructions,
        });
      }));
    } else {
      this.props.onSetModpackAttribute(['source', modId], { id: type });
    }
  }

  private onQuerySource = (evt: React.MouseEvent<any>) => {
    const { modpack } = this.props;
    const modId = evt.currentTarget.getAttribute('data-modid');
    const type = util.getSafe(modpack,
      ['attributes', 'modpack', 'source', modId, 'type'],
      'nexus');
    return this.querySource(modId, type);
  }
}

export default ModsPage;
