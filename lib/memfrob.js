/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Processes and aggregates memory reporters (like "about:memory" exposes),
 *  attempting to aggregate on compartment/tab/extensions boundaries where
 *  possible.  Bug 687724 is concerned with redoing the memory reporters to
 *  accomplish tab aggregation directly, so much of this logic will hopefully go
 *  away.
 *
 *
 * # How does about:memory work (as of 2012/01/28)?
 *
 * about:memory is the definitive representation for the memory reporter
 *  mechanism, so it's important to understand how it actually works.  Also,
 *  it's important to steal its code wherever possible.  We are stealing all
 *  the tree processing junk.
 *
 * - All memory reporters are traversed using "getReportersByProcess".  This
 *    results in a two-level map structure keyed by "process" and then by
 *    "path".  Values are "Reporter" instances.  When more than one report is
 *    received for the same path in the same process, the "merge" method is
 *    called which boosts the amount and the merge count.
 *
 * - One or more tree-building passes are performed.  The trees of interest
 *    are rooted at 'explicit', 'map/resident', 'map/pss', 'map/vsize', and
 *    'map/swap'.  Anything not processed by the tree-building passes gets
 *    lumped into the 'other' bucket which consists of tallies and statistics
 *    that don't make sense in a hierarchy (ex: page faults).
 *
 *   "buildTree" performs a prefix-filtered traversal of a Reporters-by-path
 *    map.  All matching reporters are processed and used to incrementally
 *    create a hierarchy of "TreeNode" instances that only contain name, kind,
 *    and merge count.  This is followed by a traversal of the tree where leaf
 *    nodes have their description and byte count filled in, with sub-tree byte
 *    tallies computed on the way back up.  The tree has the nodes representing
 *    the filter constraint chopped off and a description derived.
 *
 * - Derived nodes are created.  "fixUpExplicitTree" creates a synthetic
 *    "heap-unclassified" node to live in the 'explicit' tree by subtracting the
 *    total heap bytes accounted for by the 'explicit' tree from the
 *    'heap-allocated' (other) reporter's count.  (The tree needs to be
 *    traversed because some of the reporters may be KIND_NONHEAP).
 *
 * - Tree nodes are sorted and potentially bundled up into aggregate nodes
 *    if the values are small unless in verbose mode.  Specifically,
 *    "sortTreeAndInsertAggregateNodes" aggregates anything that's under 1%
 *    of the memory in play for the given tree.
 *
 * - Backslashes are flipped to front-slashes for rendering because they were
 *    flipped for reporter name generation because otherwise undesired hierarchy
 *    levels would come into effect.
 *
 * # How do interesting memory reporter paths get formatted (as of 2012/01/28)?
 *
 * Important note: JS engine stuff gets reported by its users in the mozilla
 *  codebase, not by the JS engine proper.  Specifically, "explicit/js/" is
 *  coming from XPConnect.  While it will also report generic JS-engine-wide
 *  stats, the XPConnect only reports its own runtime.  The DOM worker code
 *  reports its own JS runtime as well (under dom/workers()).  Other JS engines
 *  need to report themselves (currently), although they can make it realllly
 *  easy for themselves by using
 *  mozilla::xpconnect::memory::ReportJSRuntimeStats.
 *
 * - JS Compartments: live under "explicit/js/compartment(BLAH)" where BLAH
 *    always has front-slashes replaced by backslashes and is determined by
 *    GetCompartmentName in js/xpconnect/src/XPCJSRuntime.cpp:
 *   - "atoms": If the compartment is the default compartment for its runtime.
 *   - "[System Principal], COMPARTMENTADDR": For system compartments without
 *      a compartmentPrivate->location.
 *   - "[System Principal], LOCATION, COMPARTMENTADDR": For system compartments
 *      with a compartmentPrivate->location.  A recent commit made it so that
 *      the file path/name is used if an explicit name is not provided, which
 *      greatly increases the odds of this being usable.  Older jetpacks
 *      create one compartment per file; I think newer jetpacks might reuse
 *      the compartments?
 *   - PRINCIPALCODEBASE: This is just compartment->principals->codebase if it
 *      exists.  This seems to do a good job of tracking the tab's URL right
 *      URL; I think the JS runtime changes to have one compartment per global
 *      have probably rid of the old cases where the URI was for the initial
 *      URI that caused the compartment to be created.
 *   - "null-codebase": If there is no compartment->principals->codebase.
 *   - "null-principal": If there is no compartment->principals.
 *   - "moz-nullprincipal:{UUID}": For a principal created by nsNullPrincipal.
 *      It appears these get minted when no URIs are available or as base-case
 *      fallbacks.  Namely, nsScriptSecurityManager creates them in
 *      CreateCodebasePrincipal and GetCodebasePrincipal if the URI lacks a
 *      principal or it tries to inherit one without a base case.
 *      XPCJSContextStack::GetSafeJSContext mints one when called, and it
 *      appears to be used when there is no way to access the right context
 *      (plugin destruction), when there is no context on the stack, etc..
 *      Data URIs get covered by this at least some of the time.
 * - Layout: live under "explicit/layoyut/shell(URI)"
 * - DOM: tricky, with a base at "explicit/dom/window-objects/CATEGORY".  There
 *    are excellent comments in nsDOMMemoryReporter.cpp's
 *    CollectWindowMemoryUsage function.
 *   - CATEGORY can be "active", "cached", and "other".
 *     "cached" means the back-button cache, "other" means closed but still
 *     alive for some reason which may or may not translate to a leak.
 *   - "top=NNN (inner=NNN)" live under CATEGORY to parent inner windows:
 *      "inner-window(id=NNN, uri=URI)" with backslash escaping.  Note that
 *      the top's callout to its inner names the outermost child with its
 *      "inner", leaving everything else to be (i)frame children of that one.
 *      The URI of the inner-window is, in order of preference: the document
 *      URI, the window's principal's URI, or "[system]" as a fallback which
 *      presumably should only happen for chrome windows.
 *  - "outer-windows" live under CATEGORY to describe outer-windows and
 *     describe nothing interesting.  This means there is no way to relate the
 *     outer window to its inner windows.  Luckily it doesn't matter because
 *     it appears the outer windows always have the same size.  Note that there
 *     will be multiple instances of "outer-windows" in a category; it is not
 *     pre-aggregated.
 * - DOM workers: "explicit/dom/workers(DOMAIN)/worker(URL, MEMADDR)/".  This
 *    uses the same reporting code XPConnect uses for "explicit/js/".  Things
 *    are slightly different because we can apportion the memory cost to the
 *    owning domain a bit more.  Note that DOMAIN can apparently be empty if
 *    it's chrome/system, so don't be surprised if you see workers().
 * - mozStorage: live under "explicit/storage/sqlite/DBNAME.sqlite", there's
 *    also an "other".
 *
 * # What memory reporters are currently boring (as of 2012/01/28)?
 *
 * - Things not broken out by tab/compartment/URI and so basically useless but
 *    will be interesting once they get broken out further:
 *   - explicit/images/
 * - Everybody else.
 *
 *
 * # What are our goals, our dreams?  Our very soul?
 *
 * Our goal is to be able to associate resource usage with websites, extensions,
 *  and Firefox subsystems.  Why?  So rants can be directed more specifically
 *  than just at 'Firefox'.  Thanks to those cute adopted firefox red pandas and
 *  strong branding, it's possible to feel guilty ranting about Firefox.
 *  But ranting about the Places subsystem?  No one has a problem with that.
 *  Why?  Because Places is an inhuman monster.  And we can prove it does bad
 *  things to your performance.  Yes, those are separate thoughts.  You know
 *  what you did, Places.
 *
 * Because blame can be a complex thing in this age of third-party widgets,
 *  we want a representation that is not simply hierarchical.  For example, it
 *  makes sense to both blame the website embedding a facebook 'like' button for
 *  its resource utilization as much as we also blame facebook for the aggregate
 *  cost of the N 'like' buttons across all of our open tabs.
 *
 * We want some sense of time.  We like to look at graphs, and time is great for
 *  that.  It can also be useful to see the dirt on a recently closed window/tab
 *  so that we don't have to be super-fast on our feet.  Also, we are likely
 *  to be more interested in new tabs than old tabs, etc.
 *
 * We want to facilitate the user's ability to rapidly find something to blame.
 *  Because if they don't find someone to blame quickly, they might blame us!
 *  To wit, we want to automatically find big users of memory/cpu/IO.
 *
 * # How do we make our goals/dreams/soul reality?
 *
 * - DOM's window hierarchies are processed to find windows
 **/

const { Cc, Ci, Cu, Cr, Cm } = require('chrome');

const BLAME_EXT  = 'extension',
      BLAME_SITE = 'website',
      BLAME_SUBSYSTEM = 'subsystem';

////////////////////////////////////////////////////////////////////////////////
// stolen aboutMemory.js code

const KIND_NONHEAP = Ci.nsIMemoryReporter.KIND_NONHEAP;
const KIND_HEAP    = Ci.nsIMemoryReporter.KIND_HEAP;
const KIND_OTHER   = Ci.nsIMemoryReporter.KIND_OTHER;
const UNITS_BYTES  = Ci.nsIMemoryReporter.UNITS_BYTES;
const UNITS_COUNT  = Ci.nsIMemoryReporter.UNITS_COUNT;
const UNITS_COUNT_CUMULATIVE = Ci.nsIMemoryReporter.UNITS_COUNT_CUMULATIVE;
const UNITS_PERCENTAGE = Ci.nsIMemoryReporter.UNITS_PERCENTAGE;

const kUnknown = -1;    // used for _amount if a memory reporter failed

function Reporter(aPath, aKind, aUnits, aAmount, aDescription)
{
  this._path        = aPath;
  this._kind        = aKind;
  this._units       = aUnits;
  this._amount      = aAmount;
  this._description = aDescription;
  // this._nMerged is only defined if > 1
  // this._done is defined when getBytes is called
}

Reporter.prototype = {
  // Sum the values (accounting for possible kUnknown amounts), and mark |this|
  // as a dup.  We mark dups because it's useful to know when a reporter is
  // duplicated;  it might be worth investigating and splitting up to have
  // non-duplicated names.
  merge: function(r) {
    if (this._amount !== kUnknown && r._amount !== kUnknown) {
      this._amount += r._amount;
    } else if (this._amount === kUnknown && r._amount !== kUnknown) {
      this._amount = r._amount;
    }
    this._nMerged = this._nMerged ? this._nMerged + 1 : 2;
  },

  treeNameMatches: function(aTreeName) {
    // Nb: the '/' must be present, because we have a KIND_OTHER reporter
    // called "explicit" which is not part of the "explicit" tree.
    aTreeName += "/";
    return this._path.slice(0, aTreeName.length) === aTreeName;
  }
};

function getReportersByProcess(aMgr)
{
  // Process each memory reporter:
  // - Make a copy of it into a sub-table indexed by its process.  Each copy
  //   is a Reporter object.  After this point we never use the original memory
  //   reporter again.
  //
  // - Note that copying rOrig.amount (which calls a C++ function under the
  //   IDL covers) to r._amount for every reporter now means that the
  //   results as consistent as possible -- measurements are made all at
  //   once before most of the memory required to generate this page is
  //   allocated.
  var reportersByProcess = {};

  function addReporter(aProcess, aPath, aKind, aUnits, aAmount, aDescription)
  {
    var process = aProcess === "" ? "Main" : aProcess;
    var r = new Reporter(aPath, aKind, aUnits, aAmount, aDescription);
    if (!reportersByProcess[process]) {
      reportersByProcess[process] = {};
    }
    var reporters = reportersByProcess[process];
    var reporter = reporters[r._path];
    if (reporter) {
      // Already an entry;  must be a duplicated reporter.  This can happen
      // legitimately.  Merge them.
      reporter.merge(r);
    } else {
      reporters[r._path] = r;
    }
  }

  // Process vanilla reporters first, then multi-reporters.
  var e = aMgr.enumerateReporters();
  while (e.hasMoreElements()) {
    var rOrig = e.getNext().QueryInterface(Ci.nsIMemoryReporter);
    try {
      addReporter(rOrig.process, rOrig.path, rOrig.kind, rOrig.units,
                  rOrig.amount, rOrig.description);
    }
    catch(e) {
      debug("An error occurred when collecting results from the memory reporter " +
            rOrig.path + ": " + e);
    }
  }
  var e = aMgr.enumerateMultiReporters();
  while (e.hasMoreElements()) {
    var mrOrig = e.getNext().QueryInterface(Ci.nsIMemoryMultiReporter);
    try {
      mrOrig.collectReports(addReporter, null);
    }
    catch(e) {
      debug("An error occurred when collecting a multi-reporter's results: " + e);
    }
  }

  return reportersByProcess;
}

// There are two kinds of TreeNode.
// - Leaf TreeNodes correspond to Reporters and have more properties.
// - Non-leaf TreeNodes are just scaffolding nodes for the tree;  their values
//   are derived from their children.
function TreeNode(aName)
{
  // Nb: _units is not needed, it's always UNITS_BYTES.
  this._name = aName;
  this._kids = [];
  // All TreeNodes have these properties added later:
  // - _amount (which is never |kUnknown|)
  // - _description
  //
  // Leaf TreeNodes have these properties added later:
  // - _kind
  // - _nMerged (if > 1)
  // - _hasProblem (only defined if true)
  //
  // Non-leaf TreeNodes have these properties added later:
  // - _hideKids (only defined if true)
}

TreeNode.prototype = {
  findKid: function(aName) {
    for (var i = 0; i < this._kids.length; i++) {
      if (this._kids[i]._name === aName) {
        return this._kids[i];
      }
    }
    return undefined;
  },

  toString: function() {
    return formatBytes(this._amount);
  }
};

TreeNode.compare = function(a, b) {
  return b._amount - a._amount;
};

/**
 * From a list of memory reporters, builds a tree that mirrors the tree
 * structure that will be shown as output.
 *
 * @param aReporters
 *        The table of Reporters, indexed by path.
 * @param aTreeName
 *        The name of the tree being built.
 * @return The built tree.
 */
function buildTree(aReporters, aTreeName)
{
  // We want to process all reporters that begin with |aTreeName|.  First we
  // build the tree but only fill the properties that we can with a top-down
  // traversal.

  // There should always be at least one matching reporter when |aTreeName| is
  // "explicit".  But there may be zero for "map" trees;  if that happens,
  // bail.
  var foundReporter = false;
  for (var path in aReporters) {
    if (aReporters[path].treeNameMatches(aTreeName)) {
      foundReporter = true;
      break;
    }
  }
  if (!foundReporter) {
    assert(aTreeName !== 'explicit');
    return null;
  }

  var t = new TreeNode("falseRoot");
  for (var path in aReporters) {
    // Add any missing nodes in the tree implied by the path.
    var r = aReporters[path];
    if (r.treeNameMatches(aTreeName)) {
      assert(r._kind === KIND_HEAP || r._kind === KIND_NONHEAP,
             "reporters in the tree must have KIND_HEAP or KIND_NONHEAP");
      assert(r._units === UNITS_BYTES, "r._units === UNITS_BYTES");
      var names = r._path.split('/');
      var u = t;
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var uMatch = u.findKid(name);
        if (uMatch) {
          u = uMatch;
        } else {
          var v = new TreeNode(name);
          u._kids.push(v);
          u = v;
        }
      }
      // Fill in extra details from the Reporter.
      u._kind = r._kind;
      if (r._nMerged) {
        u._nMerged = r._nMerged;
      }
    }
  }

  // Using falseRoot makes the above code simpler.  Now discard it, leaving
  // aTreeName at the root.
  t = t._kids[0];

  // Next, fill in the remaining properties bottom-up.
  // Note that this function never returns kUnknown.
  function fillInTree(aT, aPrepath)
  {
    var path = aPrepath ? aPrepath + '/' + aT._name : aT._name;
    if (aT._kids.length === 0) {
      // Leaf node.  Must have a reporter.
      assert(aT._kind !== undefined, "aT._kind is undefined for leaf node");
      aT._description = getDescription(aReporters, path);
      var amount = getBytes(aReporters, path);
      if (amount !== kUnknown) {
        aT._amount = amount;
      } else {
        aT._amount = 0;
        aT._hasProblem = true;
      }
    } else {
      // Non-leaf node.  Derive its size and description entirely from its
      // children.
      assert(aT._kind === undefined, "aT._kind is defined for non-leaf node");
      var childrenBytes = 0;
      for (var i = 0; i < aT._kids.length; i++) {
        childrenBytes += fillInTree(aT._kids[i], path);
      }
      aT._amount = childrenBytes;
      aT._description = "The sum of all entries below '" + aT._name + "'.";
    }
    assert(aT._amount !== kUnknown, "aT._amount !== kUnknown");
    return aT._amount;
  }

  fillInTree(t, "");

  // Reduce the depth of the tree by the number of occurrences of '/' in
  // aTreeName.  (Thus the tree named 'foo/bar/baz' will be rooted at 'baz'.)
  var slashCount = 0;
  for (var i = 0; i < aTreeName.length; i++) {
    if (aTreeName[i] == '/') {
      assert(t._kids.length == 1, "Not expecting multiple kids here.");
      t = t._kids[0];
    }
  }

  // Set the description on the root node.
  t._description = kTreeDescriptions[t._name];

  return t;
}

function assert(aCond, aMsg)
{
  if (!aCond) {
    throw("assertion failed: " + aMsg);
  }
}

function debug(x)
{
  var content = $("content");
  var div = document.createElement("div");
  div.innerHTML = JSON.stringify(x);
  content.appendChild(div);
}

////////////////////////////////////////////////////////////////////////////////

function gather() {
  var mgr = Cc["@mozilla.org/memory-reporter-manager;1"].
      getService(Ci.nsIMemoryReporterManager);

  // Generate output for one process at a time.  Always start with the
  // Main process.
  var reportersByProcess = getReportersByProcess(mgr);
  for (var process in reportersByProcess) {
  }
}
