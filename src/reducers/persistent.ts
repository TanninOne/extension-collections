import * as actions from '../actions/persistent';

import { ICollection, IRevision } from '@nexusmods/nexus-api';
import * as _ from 'lodash';
import { types, util } from 'vortex-api';

const persistentReducer: types.IReducerSpec = {
  reducers: {
    [actions.updateCollectionInfo as any]: (state, payload) => {
      const { collectionId, revisionInfo }:
        { collectionId: string, revisionInfo: ICollection } = payload;

      const knownRevisions: IRevision[] = state[collectionId]?.revisions || [];
      const updatedRevisions = new Set(revisionInfo.revisions.map(rev => rev.revision));

      // update collection info and all the revisions that are contained in the payload but
      // keep the info about all other revisions
      return util.setSafe(state, [collectionId], {
        ..._.omit(revisionInfo, 'revisions'),
        revisions: [].concat(knownRevisions.filter(rev => updatedRevisions.has(rev.revision)),
                             revisionInfo),
      });
    },
    [actions.updateSuccessRate as any]: (state, payload) => {
      const { collectionId, revisionId, success } = payload;

      const revPath = [collectionId, 'revisions', revisionId];

      // we update the success_rate inside the revision info as well, so it gets updated
      // immediately, not just after it got fetched the next time.
      const successRate = JSON.parse(JSON.stringify(
        util.getSafe(state, [...revPath, 'info', 'success_rate'], { positive: 0, negative: 0 })));
      const oldSuccess = util.getSafe(state, [...revPath, 'success'], undefined);
      if (oldSuccess !== undefined) {
        // this isn't the first time we send a rating so subtract our previous rating
        --successRate[oldSuccess ? 'positive' : 'negative'];
      }
      ++successRate[success ? 'positive' : 'negative'];

      state = util.setSafe(state, [...revPath, 'info', 'success_rate'], successRate);

      return util.setSafe(state, [...revPath, 'success'], success);
    },
  },
  defaults: {
  },
};

export default persistentReducer;
