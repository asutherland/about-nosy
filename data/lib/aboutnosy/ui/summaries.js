/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 *
 **/

define(
  [
    'wmsy/wmsy',
    'wmsy/wlib/dates',
    './statvis',
    'text!./summaries.css',
    'exports'
  ],
  function(
    $wmsy,
    $wlib_dates,
    $ui_statvis,
    $_css,
    exports
  ) {

var wy = exports.wy =
  new $wmsy.WmsyDomain({id: 'summaries', domain: 'nosy', css: $_css});

wy.defineIdSpace("tab", function(tab) { return tab.id; });

wy.defineWidget({
  name: 'tab-summary',
  constraint: {
    type: 'summary',
    obj: { kind: 'tab' },
  },
  idspaces: ["tab"],
  structure: {
    header: {
      url: wy.bind(['topWindow', 'url']),
      date: wy.libWidget({ type: 'relative-date' }, 'openedAt'),
      statvis: wy.widget({ type: 'barvis' }, 'statlog'),
    },
    innerWindows: wy.vertList({ type: 'summary' }, 'innerWindowsView'),
  },
});

wy.defineWidget({
  name: 'inner-window-summary',
  constraint: {
    type: 'summary',
    obj: { kind: 'inner-window' },
  },
  structure: {
    header: {
      url: wy.bind('url'),
      date: wy.libWidget({ type: 'relative-date' }, 'createdAt'),
      statvis: wy.widget({ type: 'barvis' }, 'statlog'),
    },
  },
});

wy.defineWidget({
  name: 'origin-summary',
  constraint: {
    type: 'summary',
    obj: { kind: 'origin' },
  },
  structure: {
    header: {
      url: wy.bind('url'),
      date: wy.libWidget({ type: 'relative-date' }, 'openedAt'),
    },
    innerWindows: wy.vertList({ type: 'summary' }, 'innerWindowsView'),
  },
});

wy.defineWidget({
  name: 'extension-summary',
  constraint: {
    type: 'summary',
    obj: { kind: 'extension' },
  },
  structure: {
    header: {
      name: wy.bind('name'),
      date: wy.libWidget({ type: 'relative-date' }, 'openedAt'),
    },
    compartments: wy.vertList({ type: 'summary' }, 'compartments'),
  },
});

wy.defineWidget({
  name: 'subsystem-summary',
  constraint: {
    type: 'summary',
    obj: { kind: 'subsystem' },
  },
  structure: {
    header: {
      url: wy.bind('url'),
      date: wy.libWidget({ type: 'relative-date' }, 'openedAt'),
    },
    innerWindows: wy.vertList({ type: 'summary' }, 'innerWindowsView'),
  },
});


}); // end define
