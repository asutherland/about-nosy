/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Processes the serialized format of `memfrob.js` into a more consumer-friendly
 *  representation.  Read the file comments for `memfrob.js` to understand the
 *  data we are provided with, its limitations, and the expected changes in the
 *  near future.
 **/

define(
  [
    'wmsy/viewslice-array',
    'exports'
  ],
  function(
    $vs_array,
    exports
  ) {

var NullViewListener = {
  didSplice: function() {},
  didSeek: function() {},
};

/**
 * A tab's memory usage is the sum of all its inner windows' costs.
 */
function TabSummary(openedAt, statlog, topId) {
  /** What URL is the tab currently displaying? */
  this.url = '';
  this.openedAt = openedAt;

  this._topId = topId;
  this.topWindow = null;

  this.innerWindows = [];
  this.innerWindowsView = new $vs_array.ArrayViewSlice(this.innerWindows,
                                                       NullViewListener);

  this.statlog = statlog;
}
TabSummary.prototype = {
  kind: 'tab',
};

/**
 * Resource utilization for an inner window, both layout and DOM.  Until
 *  the dom+layout memory reporter fusion lands (bug 671299), layout costs
 *  are an approximation derived from the total layout cost for a URL divided
 *  by its number of instances.
 */
function InnerWindowSummary(uri) {
  this.uri = uri;
  this.origin = null;
}
InnerWindowSummary.prototype = {
  kind: 'inner-window',
};

/**
 * Aggregate resource usage for a given origin: its JS compartment, all DOM,
 *  all layout.
 */
function OriginSummary(originUri, createdAt) {
  this.uri = originUri;
  this.createdAt = createdAt;

  this.relatedThings = [];
  this.relatedThingsView = new $vs_array.ArrayViewSlice(this.relatedThings,
                                                        NullViewListener);
}
OriginSummary.prototype = {
  kind: 'origin',
};

function ExtensionSummary() {
}
ExtensionSummary.prototype = {
  kind: 'extension',
};

function SubsystemSummary() {
}
SubsystemSummary.prototype = {
  kind: 'subsystem',
};

function CompartmentSummary() {
}
CompartmentSummary.prototype = {
  kind: 'compartment',
};

function Statlog() {
}
Statlog.prototype = {
};

function AggrStatlog() {
}
AggrStatlog.prototype = {
};

/**
 *
 */
function StatMaster() {
}
StatMaster.prototype = {
  makeStatlog: function(statId) {
  },

  makeAggrStatlog: function() {
  },
};


function MemFrobConsumer() {
  this.statMaster = new StatMaster();

  this.tabs = [];
  this.tabsByOuterWindowId = {};
  this.origins = [];
  this.originsByUri = {};
  this.extensions = [];
  this.subsystems = [];

  this.tabsView = new $vs_array.ArrayViewSlice(this.tabs, NullViewListener);
  this.originsView = new $vs_array.ArrayViewSlice(this.origins,
                                                  NullViewListener);
  this.extensionsView = new $vs_array.ArrayViewSlice(this.extensions,
                                                     NullViewListener);
  this.subsystemsView = new $vs_array.ArrayViewSlice(this.subsystems,
                                                     NullViewListener);

}
exports.MemFrobConsumer = MemFrobConsumer;
MemFrobConsumer.prototype = {
  _trackOrigin: function(originUri, timestamp, thing) {
    var origin;
    if (this.originsByUri.hasOwnProperty(originUri)) {
      origin = this.originsByUri[originUri];
    }
    else {
      origin = new OriginSummary(originUri);
      this.originsByUri[originUri] = origin;
      this.originsView.add(origin);
    }
    origin.relatedThingsView.add(thing);
    thing.origin = origin;
    return origin;
  },

  _forgetOrigin: function(thing) {
    var origin = thing.origin;
    thing.origin = null;
    origin.relatedThingsView.remove(thing);
    if (origin.relatedThings.length === 0) {
      delete this.originsByUri[origin.uri];
      this.originsView.remove(origin);
    }
  },

  /**
   * Consume window info, which is currently just DOM info.  This tells us
   *  about:
   *
   * - Tabs: We find what InnerWindows/Origins are active in a tab.
   * - InnerWindows: We authoritatively find out about these.
   * - Origins: We blame origins for their DOM usage.
   */
  _consumeWindowsBlock: function(windows, timestamp) {
    var i, outerId, statlogger, tab;
    for (i = 0; i < windows.addedOuter.length; i++) {
      // this got immediately serialized to keep the inner windows out
      var outerData = JSON.parse(windows.addedOuter[i]);

      tab = new TabSummary(timestamp, this.statMaster.makeAggrStatlog(),
                           outerData.topId);
      this.tabsByOuterWindowId[outerData.id] = tab;
      this.tabsView.add(tab);
    }

    for (i = 0; i < windows.addedInner.length; i += 2) {
      outerId = windows.addedInner[i];
      var innerData = windows.addedInner[i+1];

      tab = this.tabsByOuterWindowId[outerId];
      var innerSummary = new InnerWindowSummary(
                           innerData.uri,
                           this.statMaster.makeStatlog(innerData.statId));
      tab.innerWindowsView.add(innerSummary);
      tab.statlog.aggregate(innerSummary.statlog);

      // (this will only occur during the initial outer window add case)
      if (tab._topId === innerData.id)
        tab.topWindow = innerSummary;
    }

    for (i = 0; i < windows.modifiedOuter.length; i++) {
      var outerDelta = windows.modifiedOuter[i];

      // - update topWindow, including generating an update
      tab = this.tabsByOuterWindowId[outerDelta.id];
      tab._topId = outerDelta.topId;
      // TODO generate update notification
    }

    var self = this;
    function removeInner(innerSummary) {
      self.statMaster.kill(innerSummary.statlog);
      self._forgetOrigin(innerSummary);
    }

    for (i = 0; i < windows.removedOuter.length; i++) {
    }

    // invariant: We don't hear about inner removals for outers removed in the
    //  same block.
    for (i = 0; i < windows.removedInner.length; i++) {
    }
  },

  /**
   * Consume layout info.  This tells us about:
   *
   * - InnerWindows: We get to proportionately blame them for their layout
   *    usage.  (Proportionately because we only get a sum for a URL.)
   * - Origins: We get to blame them for all of the layout usage for a URL.
   */
  _consumeShellsBlock: function(shells) {
    var i;

    for (i = 0; i < shells.added.length; i++) {
    }

    for (i = 0; i < shells.modified.length; i++) {
    }

    for (i = 0; i < shells.removed.length; i++) {
    }
  },

  _consumeCompartmentsBlock: function() {
  },

  _consumeStatistics: function(stats) {
    for (var i = 0; i < stats.length; i += 2) {
      var statId = stats[i], value = stats[i+1];

    }
  },

  consumeExplicitWireRep: function(wireRep) {
    var timestamp = new Date(wireRep.timestamp);

    this._consumeWindowsBlock(wireRep.windows, timestamp);
    this._consumeShellsBlock(wireRep.shells);
    this._consumeCompartmentsBlock(wireRep.compartments);

    this._consumeStatistics(wireRep.statistics);
  },

};

}); // end define
