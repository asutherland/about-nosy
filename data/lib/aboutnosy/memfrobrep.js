/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Processes the serialized format of `memfrob.js` into a more consumer-friendly
 *  representation.  Read the file comments for `memfrob.js` to understand the
 *  data we are provided with, its limitations, and the expected changes in the
 *  near future.
 *
 * Note: This file pretends like the term "URI" does not exist and only uses
 *  "URL" because it's really confusing otherwise.
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

const PROTO_TO_SORT_SENTINEL = {
  // lump internal stuff and extensions up high.
  'about': 'A',
  'chrome': 'A',
  'resource': 'A',
  'extension content': 'B',

  'http': 'J',
  'https': 'J',
  'ftp': 'K',
  'ws': 'L',
  'wss': 'L',
}, DEFAULT_SORT_SENTINEL = 'Z';
function makeUrlSortKey(url) {
  if (!url)
    return DEFAULT_SORT_SENTINEL;
  // figure the 'protocol' out, use it to create our prefix
  var idx = url.indexOf(':'),
      proto = url.substring(0, idx++),
      sortKey;
  if (PROTO_TO_SORT_SENTINEL.hasOwnProperty(proto))
    sortKey = PROTO_TO_SORT_SENTINEL[proto];
  else
    sortKey = DEFAULT_SORT_SENTINEL;

  // skip front-slashes
  while (url[idx] === '/') {
    idx++;
  }
  var idxFrontSlash = url.indexOf('/', idx);
  if (idxFrontSlash === -1)
    idxFrontSlash = url.length;
  var domain = url.substring(idx, idxFrontSlash);
  // we should now just be left with a domain name which we want to reverse
  //  java package style.  'www.blah.com' => 'com.blah.www'.
  var bits = domain.split('.');
  bits.reverse();
  return sortKey + bits.join('.');
}

function makeUrlSortyViewSlice(listObj, sortAttr) {
  return new $vs_array.ArrayViewSlice(
    listObj, NullViewListener, null,
    function keyFetcher(obj) {
      return makeUrlSortKey(obj[sortAttr]);
    },
    function keyComparator(a, b) {
      return a.localeCompare(b);
    });
}

////////////////////////////////////////////////////////////////////////////////
// Summary Objects

/**
 * A tab's memory usage is the sum of all its inner windows' costs.
 */
function TabSummary(id, createdAt, statlog, topId) {
  this.id = id;
  this.createdAt = createdAt;

  this._topId = topId;
  this.topWindow = null;

  this.innerWindows = [];
  this.innerWindowsView = makeUrlSortyViewSlice(this.innerWindows, 'url');
  this.kidsView = this.innerWindowsView;

  this.statlog = statlog;
  this.stats = [statlog];

  this.collapsed = true;
}
TabSummary.prototype = {
  kind: 'tab',
  brand: 'tab',

  getInnerWindowById: function(id) {
    for (var i = 0; i < this.innerWindows.length; i++) {
      if (this.innerWindows[i].id === id)
        return this.innerWindows[i];
    }

    return null;
  },

  get name() {
    if (this.topWindow)
      return this.topWindow.url;
    return '???';
  },
};

/**
 * Resource utilization for an inner window, both layout and DOM.  Until
 *  the dom+layout memory reporter fusion lands (bug 671299), layout costs
 *  are an approximation derived from the total layout cost for a URL divided
 *  by its number of instances.
 */
function InnerWindowSummary(id, url, tab, createdAt, statlog) {
  this.id = id;
  this.url = this.name = url;
  this.tab = tab;
  this.origin = null;

  this.createdAt = createdAt;

  this.statlog = statlog;
  this.stats = [statlog];

  this.collapsed = true;
}
InnerWindowSummary.prototype = {
  kind: 'inner-window',
  brand: 'win',

  die: function() {
    this.statlog.die();
    if (this.origin)
      this.origin.forgetUser(this);
  },

  get contextName() {
    if (this.tab)
      return this.tab.name;
    else
      return '(missing context)';
  },
};

var AggregatingSummary = {
  trackCompartment: function(cmpt) {
    this.compartmentsView.add(cmpt);
    this.statlog.aggregate(cmpt.statlog);
    cmpt.owner = this;
  },
  forgetCompartment: function(cmpt) {
    this.compartmentsView.remove(cmpt);
  },

  get isEmpty() {
    return this.compartments.length === 0;
  },
};

/**
 * Aggregate resource usage for a given origin: its JS compartment, all DOM,
 *  all layout.
 */
function OriginSummary(originUrl, createdAt, statlog) {
  this.url = this.name = originUrl;
  this.createdAt = createdAt;
  this.statlog = statlog;
  this.stats = [statlog];

  this.relatedThings = [];
  this.relatedThingsView = makeUrlSortyViewSlice(this.relatedThings, 'name');

  this.compartments = [];
  this.compartmentsView = makeUrlSortyViewSlice(this.compartments, 'name');

  this.kidsView = this.compartmentsView;
  this.collapsed = true;
}
OriginSummary.prototype = {
  __proto__: AggregatingSummary,
  kind: 'origin',
  brand: 'O',
  sentinel: false,

  trackUser: function(thing) {
    thing.origin = this;
    this.relatedThingsView.add(thing);
  },
  forgetUser: function(thing) {
    thing.origin = null;
    this.relatedThingsView.remove(thing);
  },
};

function ExtensionSummary(id, name, description, createdAt, statlog) {
  this.id = id;
  this.name = name;
  this.description = description;
  this.createdAt = createdAt;
  this.statlog = statlog;
  this.stats = [statlog];

  this.compartments = [];
  this.compartmentsView = makeUrlSortyViewSlice(this.compartments, 'name');
  this.kidsView = this.compartmentsView;
  this.collapsed = true;
}
ExtensionSummary.prototype = {
  __proto__: AggregatingSummary,
  kind: 'extension',
  brand: 'ext',
  sentinel: false,
};

function SubsystemSummary(name, createdAt, statlog) {
  this.name = name;
  this.statlog = statlog;
  this.stats = [statlog];
  this.createdAt = createdAt;

  this.compartments = [];
  this.compartmentsView = makeUrlSortyViewSlice(this.compartments, 'name');
  this.kidsView = this.compartmentsView;
  this.collapsed = true;
}
SubsystemSummary.prototype = {
  __proto__: AggregatingSummary,
  kind: 'subsystem',
  brand: 'sys',
  sentinel: false,
};

function CompartmentSummary(type, url, addrStr, createdAt, statlog) {
  this.type = type;
  this.name = url || (addrStr ? (type + ' ' + addrStr) : type);
  this.url = url;
  this.addrStr = addrStr;

  this.createdAt = createdAt;
  this.statlog = statlog;
  this.stats = [statlog];

  this.displayName = url || addrStr || type;

  this.owner = null;
  this.collapsed = true;
}
CompartmentSummary.prototype = {
  kind: 'compartment',
  brand: 'JS',
  sentinel: false,

  die: function() {
    this.owner.forgetCompartment(this);
    this.statlog.die();
  }
};

////////////////////////////////////////////////////////////////////////////////
// Time Series Management
//
// Eventually we can do something clever with typed arrays' ArrayBuffer and
//  ArrayBufferView classes, but for now we just use arrays because it's
//  harder to screw up.

function Statlog(statKing, statId, stats) {
  this.statKing = statKing;
  this.statId = statId;
  this.stats = stats;
  this.forwardTo = null;
}
Statlog.prototype = {
  die: function() {
    delete this.statKing.statIdsToStatlogs[this.statId];
  },
};

function AggrStatlog(statKing, summaryStats) {
  this.statKing = statKing;
  this.stats = summaryStats;
}
AggrStatlog.prototype = {
  aggregate: function(statlog) {
    statlog.forwardTo = this.stats;
  },

  die: function() {
    var index = this.statKing.aggrs.indexOf(this);
    if (index !== -1)
      this.statKing.aggrs.splice(index, 1);
  },
};

/**
 * Hands out `Statlog` instances and processes time series streams, including
 *  value normalization.
 */
function StatKing(numPoints) {
  this.numPoints = numPoints;
  this._empty = new Array(numPoints);
  for (var i = 0; i < numPoints; i++) {
    this._empty[i] = 0;
  }

  this._maxes = this._empty.concat();

  // Yes, this would want to get 'mo clever too.  Of course, if we force
  //  upstream to get 'mo clever and maintain a compact stat range, we don't
  //  need to be clever...
  this.statIdsToStatlogs = {};
  this.aggrs = [];

  // we will update this on-thee-fly
  this.chartMax = 16 * 1024 * 1024;
  this.chartMaxStr = '16M';
}
StatKing.prototype = {
  makeStatlog: function(statId) {
    var stats = this._empty.concat(),
        statlog = new Statlog(this, statId, stats);
    this.statIdsToStatlogs[statId] = statlog;
    return statlog;
  },

  makeAggrStatlog: function() {
    var stats = this._empty.concat();
    var statlog = new AggrStatlog(this, stats);
    this.aggrs.push(statlog);
    return statlog;
  },

  /**
   * Process the statistics data stream of the form [id1, val1, id2, val2, ...].
   *  We shift in a zero for all the aggregations before we process the stream.
   *  As we process the stream, we shift in the new values for all the normal
   *  loggers.  Those loggers can reference a single aggregation to also
   *  contribute to, in which case we boost the value (which we know started at
   *  zero.)
   */
  processStatisticsStream: function(data) {
    // - introduce a new zero in all aggregations
    var i, aggrs = this.aggrs;
    for (i = 0; i < aggrs.length; i++) {
      var aggr = aggrs[i];
      aggr.stats.pop();
      aggr.stats.unshift(0);
    }

    // - process the stream
    var maxValThisCycle = 0;
    const dlen = data.length, idsToLogs = this.statIdsToStatlogs;
    for (i = 0; i < dlen;) {
      var statId = data[i++], val = data[i++],
          statlog = idsToLogs[statId];
      // XXX ignore missing stats for now, but this should really be a
      //  self-diagnostic criterion.
      if (!statlog)
        continue;
      statlog.stats.pop();
      statlog.stats.unshift(val);

      if (statlog.forwardTo) {
        var summedVal = statlog.forwardTo[0] + val;
        statlog.forwardTo[0] = summedVal;
        if (summedVal > maxValThisCycle)
          maxValThisCycle = summedVal;
      }
      else if (val > maxValThisCycle) {
        maxValThisCycle = val;
      }
    }

    // - determine effective max value
    var maxes = this._maxes, maxChartVal = maxValThisCycle, curMaxVal;
    maxes.pop();
    maxes.unshift(maxValThisCycle);
    for (i = 1; i < maxes.length; i++) {
      curMaxVal = maxes[i];
      if (curMaxVal > maxChartVal)
        maxChartVal = curMaxVal;
    }
    // lower bound the maximum value for sanity purposes
    const meg = 1024 * 1024;
    if (maxChartVal < meg)
      maxChartVal = meg;

    // round up to the next megabyte
    var modMeg = maxChartVal % meg;
    if (modMeg)
      maxChartVal += (1024 * 1024 - modMeg);
    var megs = Math.floor(maxChartVal / meg);
    this.chartMaxStr = megs + "M";

    // XXX consider rounding to a nice human readable megabyte size...
    this.chartMax = maxChartVal;
  }
};

////////////////////////////////////////////////////////////////////////////////
// Rep Building

const NUM_POINTS = 60;

function MemFrobConsumer() {
  this.statKing = new StatKing(NUM_POINTS);

  this.tabs = [];
  this.tabsByOuterWindowId = {};

  this._originToThing = {};

  this._mysteriousOrigin = new OriginSummary("anon", new Date(),
                                             this.statKing.makeAggrStatlog());
  this._mysteriousOrigin.sentinel = true;
  this.origins = [this._mysteriousOrigin];
  this.originsByUrl = {};

  this.compartments = [];
  this._compartmentsByStatId = {};

  this.extensions = [];
  this.extensionsById = {};

  this._appCatchAll = new SubsystemSummary("Catch-all", new Date(),
                                           this.statKing.makeAggrStatlog());
  this._appCatchAll.sentinel = true;
  this.subsystems = [this._appCatchAll];

  this.tabsView = makeUrlSortyViewSlice(this.tabs, 'name');
  this.originsView = makeUrlSortyViewSlice(this.origins, 'name');
  this.extensionsView =  makeUrlSortyViewSlice(this.extensions, 'name');
  this.subsystemsView = makeUrlSortyViewSlice(this.subsystems, 'name');
  this._viewsByKind = {
    'tab': this.tabsView,
    'origin': this.originsView,
    'extension': this.extensionsView,
    'subsystem': this.subsystemsView,
  };

  this._issueUiUpdate = null;
  this._issueBlanketUiUpdate = null;
}
exports.MemFrobConsumer = MemFrobConsumer;
MemFrobConsumer.prototype = {
  /**
   * Consume window info, which is currently just DOM info.  This tells us
   *  about:
   *
   * - Tabs: We find what InnerWindows/Origins are active in a tab.
   * - InnerWindows: We authoritatively find out about these.
   * - Origins: We blame origins for their DOM usage.
   */
  _consumeWindowsBlock: function(windows, timestamp) {
    var i, outerId, innerId, statlogger, tab, innerSummary,
        uiUpdate = this._issueUiUpdate;

    // - outer
    for (i = 0; i < windows.addedOuter.length; i++) {
      // this got immediately serialized to keep the inner windows out
      var outerData = JSON.parse(windows.addedOuter[i]);

      tab = new TabSummary(outerData.id,
                           timestamp,
                           this.statKing.makeAggrStatlog(),
                           outerData.topId);
      this.tabsByOuterWindowId[outerData.id] = tab;
      this.tabsView.add(tab);
    }

    // - inner
    for (i = 0; i < windows.addedInner.length; i += 2) {
      outerId = windows.addedInner[i];
      var innerData = windows.addedInner[i+1];

      tab = this.tabsByOuterWindowId[outerId];
      innerSummary = new InnerWindowSummary(
                       innerData.id,
                       innerData.url,
                       tab,
                       timestamp,
                       this.statKing.makeStatlog(innerData.statId));
      tab.innerWindowsView.add(innerSummary);
      tab.statlog.aggregate(innerSummary.statlog);

      if (innerData.origin &&
          this.originsByUrl.hasOwnProperty(innerData.origin)) {
        var origin = this.originsByUrl[innerData.origin];
        origin.trackUser(innerSummary);
      }

      // (this will only occur durlng the initial outer window add case)
      if (tab._topId === innerData.id) {
        tab.topWindow = innerSummary;
        // this will affect our sort order...
        // unfortunately it will also destroy and re-create the widget
        // (the ui gets updated as a side-effect of the re-recreation)
        this.tabsView.remove(tab);
        this.tabsView.add(tab);
      }
    }

    // - modified
    for (i = 0; i < windows.modifiedOuter.length; i++) {
      var outerDelta = windows.modifiedOuter[i];

      // - update topWindow, including generating an update
      tab = this.tabsByOuterWindowId[outerDelta.id];
      tab._topId = outerDelta.topId;
      tab.topWindow = tab.getInnerWindowById(tab._topId);
      this.tabsView.remove(tab);
      this.tabsView.add(tab);
    }

    var self = this;
    function killInner(innerSummary) {
      innerSummary.die();
    }

    for (i = 0; i < windows.removedOuter.length; i++) {
      //console.log("outer removal", windows.removedOuter[i]);
      tab = this.tabsByOuterWindowId[windows.removedOuter[i]];
      this.tabsView.remove(tab);
      tab.statlog.die();
      tab.innerWindows.map(killInner);
    }

    // invariant: We don't hear about inner removals for outers removed in the
    //  same block.
    for (i = 0; i < windows.removedInner.length; i += 2) {
      outerId = windows.removedInner[i];
      innerId = windows.removedInner[i+1];
      //console.log("inner removal", outerId, innerId);

      tab = this.tabsByOuterWindowId[outerId];
      innerSummary = tab.getInnerWindowById(innerId);
      killInner(innerSummary);
      tab.innerWindowsView.remove(innerSummary);
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

  /**
   * Consume compartments, attempting to allocate them to an origin, a subystem,
   *  or an extension.
   */
  _consumeCompartmentsBlock: function(comps, timestamp) {
    var i, originThing, cmpt;

    // - added
    for (i = 0; i < comps.added.length; i++) {
      var compData = comps.added[i];

      switch (compData.type) {
        // - system: extension or subsystem
        case 'sys':
          if (compData.extensionInfo) {
            var extInfo = compData.extensionInfo;
            if (!this.extensionsById.hasOwnProperty(extInfo.id)) {
              originThing = new ExtensionSummary(
                              extInfo.id, extInfo.name, extInfo.description,
                              timestamp,
                              this.statKing.makeAggrStatlog());
              this.extensionsById[extInfo.id] = originThing;
              this.extensionsView.add(originThing);
            }
            else {
              originThing = this.extensionsById[extInfo.id];
            }
          }
          else {
            originThing = this._appCatchAll;
          }
          break;

        // - atoms, null: catch-all subsystem
        case 'atoms':
        case 'null':
          originThing = this._appCatchAll;
          break;

        // - anon: mysterious origin! :)
        case 'anon':
          originThing = this._mysteriousOrigin;
          break;

        // - web: an actual content (shared) origin
        case 'web':
          if (!this.originsByUrl.hasOwnProperty(compData.url)) {
            var useName = compData.url;
            if (compData.extensionInfo) {
              useName = "extension content: " + compData.extensionInfo.name;
            }
            originThing = new OriginSummary(
                            useName, timestamp,
                            this.statKing.makeAggrStatlog());
            this.originsByUrl[compData.url] = originThing;
            this.originsView.add(originThing);
          }
          else {
            originThing = this.originsByUrl[compData.url];
          }
          break;
      }

      cmpt = new CompartmentSummary(
               compData.type, compData.url, compData.addrStr,
               timestamp,
               this.statKing.makeStatlog(compData.statId));
      this._compartmentsByStatId[compData.statId] = cmpt;
      originThing.trackCompartment(cmpt);
    }

    // - removed
    for (i = 0; i < comps.removed.length; i++) {
      cmpt = this._compartmentsByStatId[comps.removed[i]];
      var owner = cmpt.owner;
      cmpt.die();

      if (owner.isEmpty) {
        this._viewsByKind[owner.kind].remove(owner);
        switch (owner.kind) {
          case 'extension':
            delete this.extensionsById[owner.id];
            break;
          case 'origin':
            delete this.originsByUrl[owner.url];
            break;
        }
      }
    }
  },

  consumeExplicitWireRep: function(wireRep) {
    var timestamp = new Date(wireRep.timestamp);

    // - compartments (=> origins, extensions, subsystems)
    // Create these prior to windows so we can relate inner windows to their
    //  origins.
    this._consumeCompartmentsBlock(wireRep.compartments, timestamp);

    // - windows (=> tabs, inner windows)
    this._consumeWindowsBlock(wireRep.windows, timestamp);

    // - shells
    // this is going to get merged in to windows soon...
    this._consumeShellsBlock(wireRep.shells);

    this.statKing.processStatisticsStream(wireRep.statistics);
    this._issueBlanketUiUpdate('statvis');
  },

};

////////////////////////////////////////////////////////////////////////////////

}); // end define
