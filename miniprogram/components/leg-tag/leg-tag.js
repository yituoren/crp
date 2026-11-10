// Leg type tag (the website's LegTag): the type code, with the type name when full
const { typeCode, legTypeLabel } = require('../../utils/types');
const race = require('../../utils/race');

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { type: { type: String, value: '' }, full: { type: Boolean, value: false }, episodeId: { type: Number, value: 0 } },
  data: { code: '', label: '' },
  observers: {
    'type, episodeId': function (type, episodeId) {
      this.setData({ code: typeCode(type), label: legTypeLabel(type, race.isLastEpisode(episodeId || undefined)) });
    },
  },
});
