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

wy.defineIdSpace("summary", function(summary) { return summary.id; });

wy.defineWidget({
  name: 'summary-capsule',
  constraint: {
    type: 'summary-capsule',
  },
  idspaces: ["summary"],
  structure: {
    headerRow: {
      lefty: {
        brand: wy.bind('brand'),
        twisty: {},
      },
      labelBox: {
        name: wy.bind('name'),
        date: wy.libWidget({ type: 'relative-date' }, 'createdAt'),
      },
      stats: wy.horizList({ type: 'statvis' }, 'stats'),
    },
    kids: wy.vertList({ type: 'summary-line' }, wy.NONE),
  },
  impl: {
    postInitUpdate: function() {
      this.collapsed = true;
      this.domNode.setAttribute("collapsed", this.collapsed);
      if (!this.collapsed) {
        this.kids_set(this.obj.kidsView);
      }
    },
    toggleCollapsed: function() {
      this.collapsed = !this.collapsed;
      if (this.collapsed) {
        this.kids_set(null);
      }
      else {
        this.kids_set(this.obj.kidsView);
      }
      this.domNode.setAttribute("collapsed", this.collapsed);
    },
  },
  events: {
    root: {
      enter_key: function() {
        this.toggleCollapsed();
      },
    },
    headerRow: {
      click: function() {
        this.toggleCollapsed();
      }
    },
  },
});

wy.defineWidget({
  name: 'summary-line',
  constraint: {
    type: 'summary-line',
  },
  structure: {
    brand: wy.bind('brand'),
    labelBox: {
      name: wy.bind('name'),
      date: wy.libWidget({ type: 'relative-date' }, 'createdAt'),
    },
    statvis: wy.horizList({ type: 'statvis' }, 'stats'),
  },
});



}); // end define
