import InstallDriver from '../../util/InstallDriver';

import InstallProgress from './InstallProgress';

import i18next from 'i18next';
import * as React from 'react';
import { Button, Carousel, OverlayTrigger, Popover } from 'react-bootstrap';
import { WithTranslation } from 'react-i18next';
import { FlexLayout, Icon, types, util } from 'vortex-api';

// tslint:disable-next-line:no-var-requires
const { ErrorBoundary } = require('vortex-api');

// const CYCLE_INTERVAL = 10 * 1000;
const CYCLE_INTERVAL = null;

interface IInstallDialogInstallingProps extends WithTranslation {
  driver: InstallDriver;
}

class InstallDialogInstalling extends React.Component<IInstallDialogInstallingProps, {}> {
  public render(): JSX.Element {
    const { t, driver } = this.props;
    const { installedMods } = this.props.driver;

    return (
      <FlexLayout type='column' className='modpack-flex-installing'>
        <FlexLayout.Flex>
          <Carousel
            interval={CYCLE_INTERVAL}
            prevIcon={<Icon name='nav-back'/>}
            nextIcon={<Icon name='nav-forward'/>}
          >
            {installedMods.map(mod => this.renderItem(mod))}
          </Carousel>
        </FlexLayout.Flex>
        <FlexLayout.Fixed style={{ width: '90%' }}>
          <InstallProgress t={t} driver={driver} />
        </FlexLayout.Fixed>
      </FlexLayout>
    );
  }

  private renderItem(mod: types.IMod): JSX.Element {
    const { t } = this.props;

    const name = util.renderModName(mod);
    const author = util.getSafe(mod, ['attributes', 'author'], '<Unknown>');
    const short = util.getSafe(mod, ['attributes', 'shortDescription'], '');
    const description = util.getSafe(mod, ['attributes', 'description'], undefined);
    const url = util.getSafe(mod, ['attributes', 'pictureUrl'], undefined);

    const popover = !!description ? (
      <Popover
          id={`modpack-mod-description-${mod.id}`}
          className='modpack-description-popover'
      >
        <h3>{name}</h3>
        <div>{(util as any).renderBBCode(description)}</div>
      </Popover>
    ) : null;

    return (
      <Carousel.Item key={mod.id}>
        <img src={url} />
        <Carousel.Caption>
          <h1>{name}</h1>
          <h3>{t('by {{author}}', {
            replace: {
              author,
            },
          })}</h3>
          <p>{short}</p>
          {!!description ? (
            <OverlayTrigger trigger='click' rootClose placement='top' overlay={popover}>
              <Button>{t('Full description')}</Button>
            </OverlayTrigger>
          ) : null}
        </Carousel.Caption>
      </Carousel.Item>
    );
  }
}

export default InstallDialogInstalling;
