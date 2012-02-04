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
  doc: 'Top-level expandable summary with embedded specialized body.',
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
    body: wy.widget({ type: 'summary-body' }, wy.NONE),
  },
  impl: {
    postInitUpdate: function() {
      this.collapsed = true;
      this.domNode.setAttribute("collapsed", this.collapsed);
      if (!this.collapsed) {
        this.body_set(this.obj);
      }
    },
    toggleCollapsed: function() {
      this.collapsed = !this.collapsed;
      if (this.collapsed) {
        // nuke the binding out of existence
        var bodyElem = this.body_element;
        bodyElem.binding.destroy(false, false);
        delete bodyElem['binding'];
        // and nuke its DOM structure too, noting that this is not perfect.
        while (bodyElem.lastChild)
          bodyElem.removeChild(bodyElem.lastChild);
        // XXX double-check our classes are not accumulating redundancy or
        //  corrupting the ordering (which could affect traversal)
        // (Our previous nuking strategy was to try and have a binding that
        //  was just empty, but the decision space kept betraying me, so I
        //  gave up on that.  It is worth considering creating a helper for
        //  the wy.NONE case that accomplishes the same thing, but more
        //  thoroughly in terms of DOM destruction.)
      }
      else {
        this.body_set(this.obj);
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
  name: 'summary-body-generic',
  doc: 'Generic/unspecialized summary body; just displays kids.',
  constraint: {
    type: 'summary-body',
    obj: { kind: wy.WILD },
  },
  structure: {
    kids: wy.vertList({ type: 'summary-line' }, 'kidsView'),
  }
});

wy.defineWidget({
  name: 'summary-body-origin',
  doc: 'per-Origin summary body; displays kids and users.',
  constraint: {
    type: 'summary-body',
    obj: { kind: 'origin' },
  },
  structure: {
    compartments: wy.vertList({ type: 'summary-line' }, 'compartments'),
    usersLabel: "Used by:",
    users: wy.vertList({ type: 'context-summary-line' }, 'relatedThings'),
  }
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

wy.defineWidget({
  name: 'context-summary-line',
  constraint: {
    type: 'context-summary-line',
  },
  structure: {
    brand: wy.bind('brand'),
    labelBox: {
      name: wy.bind('name'),
      context: ['in ', wy.bind('contextName')],
    },
    statvis: wy.horizList({ type: 'statvis' }, 'stats'),
  },
});



}); // end define
