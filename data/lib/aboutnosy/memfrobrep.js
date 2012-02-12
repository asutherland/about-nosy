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
function InnerWindowSummary(id, url, tab, createdAt, aggrStatlog, statlog) {
  this.id = id;
  this.url = this.name = url;
  this.tab = tab;
  this.origin = null;

  this.createdAt = createdAt;

  aggrStatlog.aggregate(statlog);
  this.statlog = aggrStatlog;
  this.domStatlog = statlog;
  this.stats = [aggrStatlog];

  this.collapsed = true;
}
InnerWindowSummary.prototype = {
  kind: 'inner-window',
  brand: 'win',

  changeUrl: function(newUrl) {
    this.url = this.name = newUrl;
  },

  die: function() {
    if (this.origin)
      this.origin.forgetUser(this);
    this.statlog.die();
    this.domStatlog.die();
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
    if (cmpt.cpuStatlog)
      this.cpuStatlog.aggregate(cmpt.cpuStatlog);
    cmpt.owner = this;
  },
  forgetCompartment: function(cmpt) {
    this.statlog.unaggregate(cmpt.statlog);
    if (cmpt.cpuStatlog)
      this.cpuStatlog.unaggregate(cmpt.cpuStatlog);
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
function OriginSummary(originUrl, createdAt, memStatlog, cpuStatlog) {
  this.url = this.name = originUrl;
  this.createdAt = createdAt;
  this.statlog = memStatlog;
  this.cpuStatlog = cpuStatlog;
  this.stats = [memStatlog];
  if (cpuStatlog)
    this.stats.push(cpuStatlog);

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
    this.statlog.aggregate(thing.statlog);
    this.relatedThingsView.add(thing);
  },
  forgetUser: function(thing) {
    this.statlog.unaggregate(thing.statlog);
    thing.origin = null;
    this.relatedThingsView.remove(thing);
  },
};

function ExtensionSummary(id, name, description, createdAt, memStatlog,
                          cpuStatlog) {
  this.id = id;
  this.name = name;
  this.description = description;
  this.createdAt = createdAt;
  this.statlog = memStatlog;
  this.cpuStatlog = cpuStatlog;
  this.stats = [memStatlog];
  if (cpuStatlog)
    this.stats.push(cpuStatlog);

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
  this.cpuStatlog = null;
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
  this.cpuStatlog = null;
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
    if (this.cpuStatlog)
      this.cpuStatlog.die();
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
    // forget about us
    delete this.statKing.statIdsToStatlogs[this.statId];

    // have people we are forwarding to forget about us
    if (this.forwardTo) {
      for (var i = 0; i < this.forwardTo.length; i++) {
        var aggr = this.forwardTo[i],
            idx = aggr.aggregates.indexOf(this);
        if (idx !== -1)
          aggr.aggregates.splice(idx, 1);
      }
    }
  },
};

function AggrStatlog(statKing, summaryStats) {
  this.statKing = statKing;
  this.stats = summaryStats;
  this.forwardTo = null;
  this.aggregates = [];
}
AggrStatlog.prototype = {
  aggregate: function(statlog) {
    this.aggregates.push(statlog);
    if (!statlog.forwardTo)
      statlog.forwardTo = [];
    statlog.forwardTo.push(this);
  },

  unaggregate: function(statlog) {
    var idx = this.aggregates.indexOf(statlog);
    if (idx !== -1)
      this.aggregates.splice(idx, 1);
    idx = statlog.forwardTo.indexOf(this);
    if (idx !== -1)
      statlog.forwardTo.splice(idx, 1);
  },

  die: function() {
    // have the things we are aggregating from forget us
    for (var i = 0; i < this.aggregates.length; i++) {
      var statlog = this.aggregates[i],
          idx = statlog.forwardTo.indexOf(this);
      if (idx !== -1)
        statlog.forwardTo.splice(idx, 1);
    }

    // have the king forget about us
    var index = this.statKing.aggrs.indexOf(this);
    if (index !== -1)
      this.statKing.aggrs.splice(index, 1);
  },
};

/**
 * Hands out `Statlog` instances and processes time series streams, including
 *  value normalization.
 */
function StatKing(name, numPoints, unitLabel, unitSize, sparseSamples) {
  this.name = name;
  this.numPoints = numPoints;
  this.unitLabel = unitLabel;
  this.unitSize = unitSize;
  this.sparseSamples = sparseSamples;
  this._empty = new Array(numPoints);
  for (var i = 0; i < numPoints; i++) {
    this._empty[i] = 0;
  }

  this._maxes = this._empty.concat();

  // Yes, this would want to get 'mo clever too.  Of course, if we force
  //  upstream to get 'mo clever and maintain a compact stat range, we don't
  //  need to be clever...
  this.statIdsToStatlogs = {};
  this.statlogs = sparseSamples ? [] : null;
  this.aggrs = [];

  // we will update this on-thee-fly
  this.chartMax = 16 * this.unitSize;
  this.chartMaxStr = '16' + this.unitLabel;
}
StatKing.prototype = {
  makeStatlog: function(statId) {
    var stats = this._empty.concat(),
        statlog = new Statlog(this, statId, stats);
    this.statIdsToStatlogs[statId] = statlog;
    if (this.statlogs)
      this.statlogs.push(statlog);
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
    var i, statId, statlog,
        val, maxValThisCycle = 0;
    const dlen = data.length, idsToLogs = this.statIdsToStatlogs;

    // - process the stream
    function doForward(forwardTo) {
      for (var iTarg = 0; iTarg < forwardTo.length; iTarg++) {
        var fwdStatlog = forwardTo[iTarg], fwdStats = fwdStatlog.stats;

        var summedVal = fwdStats[0] + val;
        fwdStats[0] = summedVal;
        if (summedVal > maxValThisCycle)
          maxValThisCycle = summedVal;

        if (fwdStatlog.forwardTo)
          doForward(fwdStatlog.forwardTo);
      }
    }

    // - introduce a new zero in all aggregations
    var aggrs = this.aggrs;
    for (i = 0; i < aggrs.length; i++) {
      var aggr = aggrs[i];
      aggr.stats.pop();
      aggr.stats.unshift(0);
    }

    // For sparse samples we clock in zeroes for all and our processing
    //  just increments.
    if (this.sparseSamples) {
      var statlogs = this.statlogs;
      for (i = 0; i < statlogs.length; i++) {
        statlog = statlogs[i];
        statlog.stats.pop();
        statlog.stats.unshift(0);
      }

      for (i = 0; i < dlen;) {
        statId = data[i++];
        statlog = idsToLogs[statId];
        val = data[i++];
        var summedVal = statlog.stats[0] + val;
        statlog.stats[0] = summedVal;
        if (summedVal > maxValThisCycle)
          maxValThisCycle = summedVal;

        if (statlog.forwardTo)
          doForward(statlog.forwardTo);
      }
    }
    else {
      for (i = 0; i < dlen;) {
        statId = data[i++];
        statlog = idsToLogs[statId];
        val = data[i++];
        // XXX ignore missing stats for now, but this should really be a
        //  self-diagnostic criterion.
        if (!statlog)
          continue;
        statlog.stats.pop();
        statlog.stats.unshift(val);

        if (statlog.forwardTo) {
          doForward(statlog.forwardTo);
        }
        else if (val > maxValThisCycle) {
          maxValThisCycle = val;
        }
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
    if (maxChartVal < this.unitSize)
      maxChartVal = this.unitSize;

    // round up to the next megabyte
    var modVal = maxChartVal % this.unitSize;
    if (modVal)
      maxChartVal += (this.unitSize - modVal);
    var roundedVal = Math.floor(maxChartVal / this.unitSize);
    this.chartMaxStr = roundedVal + this.unitLabel;

    // XXX consider rounding to a nice human readable megabyte size...
    this.chartMax = maxChartVal;
  }
};

////////////////////////////////////////////////////////////////////////////////
// Rep Building

const NUM_POINTS = 60;

function MemFrobConsumer() {
  this.statKing = new StatKing('mem', NUM_POINTS, 'M', 1024 * 1024, false);
  this.cpuStatKing = new StatKing('cpu', NUM_POINTS, 'ms', 1000, true);

  this.hasCPU = false;

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

  this.shellStatsByUrl = {};

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
        shellStatsByUrl = this.shellStatsByUrl,
        uiUpdate = this._issueUiUpdate,
        uiUpdateById = this._issueUiUpdateById;

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
                       this.statKing.makeAggrStatlog(),
                       this.statKing.makeStatlog(innerData.statId));
      tab.innerWindowsView.add(innerSummary);
      tab.statlog.aggregate(innerSummary.statlog);

      // try and find a shell and aggregate its stats into our own
      if (shellStatsByUrl.hasOwnProperty(innerData.url)) {
        innerSummary.statlog.aggregate(shellStatsByUrl[innerData.url]);
      }

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
        uiUpdateById('deptab', tab.id);
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
      // dependent windows may need to update (although they will likely
      //  become unrooted and experience GC death in the future).
      uiUpdateById('deptab', tab.id);
    }

    for (i = 0; i < windows.modifiedInner.length; i++) {
      var innerDelta = windows.modifiedInner[i];

      tab = this.tabsByOuterWindowId[innerDelta.outerId];
      innerSummary = tab.getInnerWindowById(innerDelta.id);
      // the rename will affect our shell stats. ugh.
      if (shellStatsByUrl.hasOwnProperty(innerSummary.url)) {
        innerSummary.statlog.unaggregate(shellStatsByUrl[innerSummary.url]);
      }
      innerSummary.changeUrl(innerDelta.url);
      // try and get stats from the new URL
      if (shellStatsByUrl.hasOwnProperty(innerSummary.url)) {
        innerSummary.statlog.aggregate(shellStatsByUrl[innerData.url]);
      }

      // the rename may affect the ordering...
      tab.innerWindowsView.remove(innerSummary);
      tab.innerWindowsView.add(innerSummary);
      uiUpdate('summary', innerSummary);
      // if we are the defining inner window, we need to update the tab
      if (tab.topWindow === innerSummary) {
        this.tabsView.remove(tab);
        this.tabsView.add(tab);
        uiUpdateById('deptab', tab.id);
      }
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
      // we need to unaggregate the tab, but not the origin (forgetUser does
      //  that when killInner calls innerSummary.die)
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
   *
   * We don't surface the shell info directly.  Instead, we just publish the
   *  shells by their URL and have the inner windows find them and try and
   *  aggregate their stats.
   */
  _consumeShellsBlock: function(shells) {
    var i, shellStatsByUrl = this.shellStatsByUrl, shellInfo;

    for (i = 0; i < shells.added.length; i++) {
      shellInfo = shells.added[i];

      shellStatsByUrl[shellInfo.url] = this.statKing.makeStatlog(
                                         shellInfo.statId);
    }

    // we don't populate this on the other side anymore
    /*
    for (i = 0; i < shells.modified.length; i++) {
    }
    */

    for (i = 0; i < shells.removed.length; i++) {
      shellInfo = shells.removed[i];

      var statlog = shellStatsByUrl[shellInfo.url];
      statlog.die();
      delete shellStatsByUrl[shellInfo.url];
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
                              this.statKing.makeAggrStatlog(),
                              this.hasCPU ?
                                this.cpuStatKing.makeAggrStatlog() : null);
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
                            this.statKing.makeAggrStatlog(),
                            this.hasCPU ?
                              this.cpuStatKing.makeAggrStatlog() : null);
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

      if (this.hasCPU && compData.addrStr) {
        cmpt.cpuStatlog = this.cpuStatKing.makeStatlog(compData.addrStr);
        cmpt.stats.push(cmpt.cpuStatlog);
      }

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
    var memRep = wireRep.mem, cpuRep = wireRep.cpu,
        timestamp = new Date(memRep.timestamp);

    var hadCPU = this.hasCPU;
    this.hasCPU = (cpuRep !== null);
    if (!hadCPU && this.hasCPU) {
      var self = this;
      function giveCpuStatsTo(thing) {
        thing.cpuStatlog = self.cpuStatKing.makeAggrStatlog();
        thing.stats.push(thing.cpuStatlog);
        self._issueUiUpdate('summary', thing);
      }
      giveCpuStatsTo(this._appCatchAll);
    }

//console.time('chew');
    // -- memory
    // - compartments (=> origins, extensions, subsystems)
    // Create these prior to windows so we can relate inner windows to their
    //  origins.
    this._consumeCompartmentsBlock(memRep.compartments, timestamp);

    // - shells
    // this is going to get merged in to windows soon...
    // do this prior to windows so inner windows can find their shells for
    //  stats gathering purposes.
    this._consumeShellsBlock(memRep.shells);

    // - windows (=> tabs, inner windows)
    this._consumeWindowsBlock(memRep.windows, timestamp);

    this.statKing.processStatisticsStream(memRep.statistics);

    // -- cpu
    if (cpuRep.compartments)
      this.cpuStatKing.processStatisticsStream(cpuRep.compartments);
//console.timeEnd('chew');

//console.time('statvis-update');
    this._issueBlanketUiUpdate('statvis');
//console.timeEnd('statvis-update');
  },

};

////////////////////////////////////////////////////////////////////////////////

}); // end define
