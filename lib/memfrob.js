/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Processes and aggregates memory reporters (like "about:memory" exposes),
 *  attempting to aggregate on compartment/tab/extensions boundaries where
 *  possible.  Our results are intended to be sent over the wire to
 *  `memfrobrep.js` which builds a more useful representation from our work.
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
 *      exists.  Right now, this is likely to be the URI of the first page that
 *      hit the origin.  Multiple pages with the same origin can end up under
 *      the same compartment whose URI, again, will not change.  I believe
 *      this may change in the near future as efforts are made so that each
 *      compartment has only a single global object.  See bug 650353 at
 *      https://bugzilla.mozilla.org/show_bug.cgi?id=650353 for more info.
 *      There is a bug to name compartments after their common origin at
 *      https://bugzilla.mozilla.org/show_bug.cgi?id=673248 that will get
 *      mooted if the single glogbal object.
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
 * - Layout: live under "explicit/layoyut/shell(URI)".  This is going to get
 *    merged with DOM to be "dom+layout" on bug 671299, with example comment:
 *    https://bugzilla.mozilla.org/show_bug.cgi?id=671299#c14
 *    Also see https://bugzilla.mozilla.org/show_bug.cgi?id=713799 which has
 *    a follow-on bug about re-arranging things.
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
 *     outer window to its inner windows once ordering information is lost (and
 *     possibly not even then).  Luckily it doesn't matter because it appears
 *     the outer windows always have the same size.  Note that there will be
 *     multiple instances of "outer-windows" in a category; it is not
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
 * We want to enable having the UI that consumes this data live in a completely
 *  isolated universe from us and be able to just suck up data from logs.  It
 *  should also be able to fuse data from other sources as well.
 *
 * # How do we make our goals/dreams/soul reality?
 *
 * - We have a helper file `memfrobrep.js` that understands the wire format we
 *    produce.  It is where we do most of the fusion right now because its
 *    representation does not need to be easily serializable.
 **/

const { Cc, Ci, Cu, Cr, Cm } = require('chrome');
const $url = require('url');

const BLAME_EXT  = 'extension',
      BLAME_SITE = 'website',
      BLAME_SUBSYSTEM = 'subsystem';

var $am = {}, $services = {};
Cu.import("resource://gre/modules/AddonManager.jsm", $am);
Cu.import('resource://gre/modules/Services.jsm', $services);

////////////////////////////////////////////////////////////////////////////////
// stolen aboutMemory.js code
//
// stolen as of 85555:8a59519e137e
// uplifted to MPL2 from MPL1.1 per 1.1 explicitly being okay with it

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
      // !!!!! commenting this out now, too:
      //aT._description = getDescription(aReporters, path);
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
    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    // This is our only change to the aboutMemory code.  To transform the
    // backslashes back to front-slashes.  This is the only time we can really
    // do it either.  Since this is basically a destructive transform anyways,
    // this is the best time to do this.
    aT._name = aT._name.replace(/\\/g, '/');
    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
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
  // !!!!! okay, I commented this line out too:
  //t._description = kTreeDescriptions[t._name];

  return t;
}

/**
 * Gets the byte count for a particular Reporter and sets its _done
 * property.
 *
 * @param aReporters
 *        Table of Reporters for this process, indexed by _path.
 * @param aPath
 *        The path of the R.
 * @param aDoNotMark
 *        If true, the _done property is not set.
 * @return The byte count.
 */
function getBytes(aReporters, aPath, aDoNotMark)
{
  var r = aReporters[aPath];
  assert(r, "getBytes: no such Reporter: " + aPath);
  if (!aDoNotMark) {
    r._done = true;
  }
  return r._amount;
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
// Tree Retrieval and Construction

exports.gatherExplicitTree = function gatherExplicitTree() {
  var mgr = Cc["@mozilla.org/memory-reporter-manager;1"].
      getService(Ci.nsIMemoryReporterManager);

  // Generate output for one process at a time.  Always start with the
  // Main process.
  var reportersByProcess = getReportersByProcess(mgr);
  return buildTree(reportersByProcess["Main"], 'explicit');
};

////////////////////////////////////////////////////////////////////////////////
// Memory Frobber Internals

const RE_WIN_TOP = /^top=(\d+) \(inner=(\d+)\)$/,
      RE_WIN_INNER = /^inner-window\(id=(\d+), uri=(.+)\)$/,
      RE_SHELL = /^shell\(/, SHELL_LEN = ("shell(").length,
      RE_JS_COMP = /^compartment\(/, CMPTLEN = ("compartment(").length,
      SYSCMPLEN = ("[System Principal], ").length,
      RE_MOZNULL = /^moz-nullprincipal:/,
      MOZNULL_LEN = ("moz-nullprincipal:").length,
      RE_RESOURCE = /^resource:\/\/(.+)\/?/,
      RE_JAR_OR_FILE = /^(jar|file):/,
      JAR_PREFIX_LEN = ("jar:").length,
      RE_ABOUT = /^about:/;

/**
 * Compute the origin for a given URI.  Per nsScriptSecurityManager.cpp's
 *  GetOriginFromURI, it's just the scheme and hostPort.
 */
function computeOriginForUri(uriStr) {
  if (RE_ABOUT.test(uriStr))
    return uriStr;
  var url = new $url.URL(uriStr);
  var origin = url.scheme + "://" + url.host;
  if (url.port)
    origin += ":" + url.port;
  return origin;
}


var ExtensionsKing = exports.ExtensionsKing = {
  /**
   * @typedef[ExtensionInfo @dict[
   *   @key[id]
   *   @key[name]
   *   @key[description]
   * ]]{
   *   This is all directly extracted from the `Addon` with the same key.
   * }
   **/
  /**
   * @dictof["jar path" ExtensionInfo]{
   *   Map jar paths to their owning extensions.
   * }
   */
  _extensionsByJarPaths: {},
  /**
   * @listof[@dict[
   *   @key[uriStr]{
   *     The File URI spec for the extension info.
   *   }
   *   @key[info ExtensionInfo]
   * ]]
   */
  _extensionsWithPrefixes: [],

  /**
   * The addon manager has an async API so we need to fetch this info before
   *  we need it.  We also can register as a listener to hear about new
   *  extensions as they come into existence.
   *
   * XXX register as a listener; punting on it for now because the risk of
   *  screwing it up does not outweight the cost yet.
   */
  gatherInfoAboutAddons: function(callback) {
    var self = this;
    this._resProtocol = $services.Services.io.getProtocolHandler('resource')
                          .QueryInterface(Ci.nsIResProtocolHandler);

    $am.AddonManager.getAllAddons(function(addons) {
      for (var i = 0; i < addons.length; i++) {
        try {
          self._extractAddonInfo(addons[i]);
        }
        catch(ex) {
          console.error("Sadness extracting addon info", ex);
        }
      }
      callback();
    });
  },

  _extractAddonInfo: function(addon) {
    if (!("getResourceURI" in addon) ||
        (typeof(addon.getResourceURI) !== "function")) {
      return;
    }
    var addonUriStr = addon.getResourceURI(null).spec;

    var extInfo = {
      id: addon.id,
      name: addon.name,
      description: addon.description || "",
    };

    // jar?
    if (/\.xpi$/.test(addonUriStr)) {
      this._extensionsByJarPaths[addonUriStr] = extInfo;
    }
    else {
      this._extensionsWithPrefixes.push({
        uriStr: addonUriStr,
        info: extInfo,
      });
    }
  },

  /**
   * Try and map an origin to an extension.  The info we have to go on is:
   *
   * - We can convert resource URIs back into file URIs using
   *   nsIResProtocolHandler's getSubstitution mechanism.  We cannot enumerate
   *   them, so we must fetch them as we see resource URLs that we don't
   *   understand.  (There is an enumeration method on nsResProtocolHandler,
   *   but it's not scriptable and the only caller is in nsChromeRegistryChrome
   *   and it realy just wants to be for electrolysis purposes.)
   *
   * - We know from the AddonManager all of the paths of all add-on bundles,
   *   which means packed .xpi files and unpacked directories.  This allows us
   *   to perform prefix matching of paths and exact-path matching on jars to
   *   figure out what extension they belong to.
   */
  mapOriginToExtension: function(originUrl, fullUrl) {
    var useForMapping, match;
    if ((match = RE_RESOURCE.exec(originUrl))) {
      var uri;
      try {
        uri = this._resProtocol.getSubstitution(match[1]);
      }
      catch(ex) {
        console.error("Unable to translate resource URI", match[1], ex);
        return null;
      }
      useForMapping = uri.spec;
    }
    else {
      useForMapping = fullUrl;
    }
    
    if ((match = RE_JAR_OR_FILE.exec(useForMapping))) {
      if (match[1] === 'jar') {
        var idxDelim = useForMapping.lastIndexOf('!/'),
            jarPath = useForMapping.substring(JAR_PREFIX_LEN, idxDelim);
        return this._extensionsByJarPaths[jarPath];
      }
      else {
        var extsWithPrefixes = this._extensionsWithPrefixes;
        for (var i = 0; i < extsWithPrefixes.length; i++) {
          var extWithPrefix = extsWithPrefixes[i];

          if (useForMapping.indexOf(extWithPrefix.uriStr) === 0) {
            return extWithPrefix.info;
          }
        }
      }
    }
    return null;
  },
};

/**
 * Processes memory trees as produced aboutMemory.js style.
 */
function MemTreeFrobber() {
  this._nextStatId = 1;

  // -- persistent representations
  this._outerWindowsById = {};
  this._shellsByUrl = {};
  this._mainCompartmentsByName = {};

  this._resourceOrigins = {};

  // -- delta notifications for each processing pass
  this._addedOuterWindows = [];
  this._modifiedOuterWindows = [];
  this._addedInnerWindows = [];
  this._removedOuterWindows = [];
  this._removedInnerWindows = [];

  this._addedShells = [];
  this._modifiedShells = [];
  this._removedShells = [];

  this._addedCompartments = [];
  this._removedCompartments = [];

  this._statistics = [];

  this._generation = 0;
}
exports.MemTreeFrobber = MemTreeFrobber;
MemTreeFrobber.prototype = {
  _issueStatId: function() {
    return this._nextStatId++;
  },

  /**
   * Process the DOM window listings.
   *
   * Important note: this will be called once for each category type.  Cached
   *  windows will be hierarchically rooted in an equivalent location to their
   *  active brethren which means no conclusive actions should be taken
   *  regarding children in this pass (unless we are changed to receive all
   *  category windows at once.)
   */
  _processDomWindows: function(nodes, category, generation) {
    var outerWindowsById = this._outerWindowsById,
        statistics = this._statistics;

    for (var iNode = 0; iNode < nodes.length; iNode++) {
      var outerNode = nodes[iNode], outerMatch, innerMatch;
      // -- inner window cluster
      if ((outerMatch = RE_WIN_TOP.exec(outerNode._name))) {
        var outerIdStr = outerMatch[1], outerId = parseInt(outerIdStr),
            topIdStr = outerMatch[2], topId = parseInt(topIdStr), outerData;
        if (outerWindowsById.hasOwnProperty(outerIdStr)) {
          outerData = outerWindowsById[outerIdStr];

          if (outerData.topId !== topId) {
            this._modifiedOuterWindows.push({
              id: outerId,
              topId: topId,
            });
            outerData.topId = topId;
          }

          outerData.touched = generation;
        }
        else {
          outerData = outerWindowsById[outerIdStr] = {
            id: outerId,
            topId: topId,
            innerWindows: {},
            touched: generation,
          };
          // serialize this immediately so we don't capture the child windows.
          this._addedOuterWindows.push(JSON.stringify(outerData));
        }

        for (var iKid = 0; iKid < outerNode._kids.length; iKid++) {
          var innerNode = outerNode._kids[iKid];
          if (!(innerMatch = RE_WIN_INNER.exec(innerNode._name)))
            continue;
          // - inner window
          var innerIdStr = innerMatch[1], innerUrl = innerMatch[2], innerData;
          if (outerData.innerWindows.hasOwnProperty(innerIdStr)) {
            innerData = outerData.innerWindows[innerIdStr];
            innerData.touched = generation;
            // XXX consider detecting URI changes and also flagging them.
            // While traditional navigation will result in a new inner shell,
            //  use of replaceState or hash-twiddling will leave the inner
            //  window intact.
          }
          else {
            innerData = outerData.innerWindows[innerIdStr] = {
              statId: this._issueStatId(),
              id: parseInt(innerIdStr),
              url: innerUrl,
              origin: computeOriginForUri(innerUrl),
              touched: generation,
            };
            this._addedInnerWindows.push(outerId);
            this._addedInnerWindows.push(innerData);
          }

          statistics.push(innerData.statId);
          statistics.push(innerNode._amount);
        }
      }
      // (probably "outer-windows")
    }
  },

  _inferClosedWindows: function(generation) {
    for (var outerIdStr in this._outerWindowsById) {
      var outerData = this._outerWindowsById[outerIdStr];

      // - detect removed outer window
      if (outerData.touched !== generation) {
        this._removedOuterWindows.push(outerData.id);
        delete this._outerWindowsById[outerIdStr];
        // continue immediately; no need to mention the inner windows.
        continue;
      }

      // - detect removed inner windows
      for (var innerIdStr in outerData.innerWindows) {
        var innerData = outerData.innerWindows[innerIdStr];
        if (innerData.touched !== generation) {
          this._removedInnerWindows.push(outerData.id);
          this._removedInnerWindows.push(innerData.id);
          // XXX verify deletion during key iteration is actually safe per spec
          delete outerData.innerWindows[innerIdStr];
        }
      }
    }
  },

  /**
   * Process layout shells.  These are all keyed by URI.  If multiple inner
   *  windows are displaying the same URL, they will get merged by the tree
   *  logic, which is just as well because we can't tell them apart right now.
   */
  _processLayout: function(layoutNode, generation) {
    var kids = layoutNode._kids,
        shellsByUrl = this._shellsByUrl, shellUrl, shellData,
        statistics = this._statistics;

    // - walk all shells, added and logging stats
    for (var iKid = 0; iKid < kids.length; iKid++) {
      var kid = kids[iKid];

      if (!RE_SHELL.test(kid._name))
        continue;
      // (shell)
      shellUrl = kid._name.slice(SHELL_LEN, -1);

      if (shellsByUrl.hasOwnProperty(shellUrl)) {
        shellData = shellsByUrl[shellUrl];
        shellData.generation = generation;
        var curCount = kid._nMerged || 1;
        if (curCount !== shellData.count) {
          this._modifiedShells.push({
            statId: shellData.statId,
            count: curCount,
          });
        }
      }
      else {
        shellData = shellsByUrl[shellUrl] = {
          statId: this._issueStatId(),
          url: shellUrl,
          // easily derived on the other side, but hey.
          origin: computeOriginForUri(shellUrl),
          count: kid._nMerged || 1,
          generation: generation,
        };
      }
      statistics.push(shellData.statId);
      statistics.push(kid._amount);
    }

    // - detect removed shells
    for (shellUrl in shellsByUrl) {
      shellData = shellsByUrl[shellUrl];
      if (shellData.generation !== generation) {
        this._removedShells.push(shellData);
        // XXX iteration deletion fear, yeah yeah
        delete shellsByUrl[shellUrl];
      }
    }
  },

  // ??? Should we have a specialized variant for owned runtimes?
  /**
   * Process Firefox's primary JS runtime to detect compartments and to attempt
   *  to relate them to known windows.
   *
   * Important Note: The tree we are consuming has already merged all reports
   *  with the same path.  This means that in cases like where Jetpack's e10s
   *  support creates a bunch of sandboxes (like for pagemods), they will all
   *  get rolled into one.  This is handy because we would have no way to
   *  differentiate between them anyways.
   */
  _processMainJSRuntime: function(runtimeNode, generation) {
    var kids = runtimeNode._kids,
        compartmentsByName = this._mainCompartmentsByName,
        statistics = this._statistics, compName, compData;
    // - walk all compartments, adding and logging stats
    for (var iKid = 0; iKid < kids.length; iKid++) {
      var kid = kids[iKid];
      if (!RE_JS_COMP.test(kid._name))
        continue;
      // (compartment)

      var remainder, idx, compType = null, url = null, urlOrigin = null,
          extensionInfo = null, addrStr = null;
      compName = kid._name.slice(CMPTLEN, -1);

      if (compartmentsByName.hasOwnProperty(compName)) {
        compData = compartmentsByName[compName];
        // type, url, addrStr are derived from the name, so immutable
        // XXX _nMerged can change.
        compData.touched = generation;
      }
      else {
        // System compartment
        if (compName[0] === "[") {
          compType = 'sys';
          remainder = compName.substring(SYSCMPLEN);

          // gobble url if present
          if (remainder[0] !== '0') {
            idx = remainder.lastIndexOf(',');
            // chrome compartments/sandboxes are explicit
            url = remainder.substring(0, idx);
            // but the origin is useful
            urlOrigin = computeOriginForUri(url);

            // and we may be able to map it to an extension...
            extensionInfo = ExtensionsKing.mapOriginToExtension(urlOrigin, url);

            remainder = remainder.substring(idx + 2);
          }

          addrStr = remainder;
        }
        else if (compName === 'atoms') {
          compType = 'atoms';
        }
        else if (compName === 'null-codebase' ||
                 compName === 'null-principal') {
          compType = 'null';
        }
        else if (RE_MOZNULL.test(compName)) {
          compType = 'anon';
          // the UUID is useful for uniquing, let's keep it aboot
          url = compName.substring(MOZNULL_LEN);
        }
        else {
          compType = 'web';
          // Simplify to the origin since the additional information can easily
          //  be stale and confusing.  If bug 673248 for a proposal to do this
          //  in code.
          url = computeOriginForUri(compName);
          // Is this coming from an Extension's space?
          if (RE_RESOURCE.test(url)) {
            extensionInfo = ExtensionsKing.mapOriginToExtension(url, compName);
          }
        }

        compData = compartmentsByName[compName] = {
          statId: this._issueStatId(),
          type: compType,
          url: url,
          urlOrigin: urlOrigin,
          extensionInfo: extensionInfo,
          addrStr: addrStr,
          count: kid._nMerged || 1,
          touched: generation,
        };
        this._addedCompartments.push(compData);
      }

      statistics.push(compData.statId);
      statistics.push(kid._amount);
    }

    // - detect removed compartments
    for (compName in compartmentsByName) {
      compData = compartmentsByName[compName];
      if (compData.touched !== generation) {
        this._removedCompartments.push(compData.statId);
        // XXX iteration deletion fear, yeah.
        delete compartmentsByName[compName];
      }
    }
  },

  /**
   * Process the 'explicit' tree and generate a wire-protocol blurb to be
   *  processed elsewhere.
   *
   * The wire-protocol assumes a stateful consumer who has been listening to us
   *  since we were created.
   */
  processExplicitTree: function(explicitTreeNode, sampleTS) {
    var generation = ++this._generation;

    this._addedOuterWindows = [];
    this._modifiedOuterWindows = [];
    this._addedInnerWindows = [];
    this._removedOuterWindows = [];
    this._removedInnerWindows = [];

    this._addedShells = [];
    this._modifiedShells = [];
    this._removedShells = [];

    this._addedCompartments = [];
    this._removedCompartments = [];

    this._statistics = [];

    // -- DOM windows

    // XXX backwards compatible wants just "dom"
    var domNode = explicitTreeNode.findKid('dom+style'),
        winObjsNode = domNode.findKid('window-objects');

    var catNode;
    if ((catNode = winObjsNode.findKid('active')))
      this._processDomWindows(catNode._kids, 'active', generation);
    if ((catNode = winObjsNode.findKid('cached')))
      this._processDomWindows(catNode._kids, 'cached', generation);
    // The 'other' windows look boring right now, so we're skipping them.
    //  Specifically, I only see a top=none container holding a bunch of 696B
    //  windows, which I presume is the minimum overhead possible.
    // XXX consider processing other windows
    //if ((catNode = winObjsNode.findKid('other')))
    //  this._processDomWindows(catNode._kids);

    this._inferClosedWindows(generation);

    //this._processLayout(explicitTreeNode.findKid("layout"), generation);

    this._processMainJSRuntime(explicitTreeNode.findKid("js"), generation);

    return {
      timestamp: sampleTS,
      windows: {
        addedOuter: this._addedOuterWindows,
        modifiedOuter: this._modifiedOuterWindows,
        addedInner: this._addedInnerWindows,
        removedOuter: this._removedOuterWindows,
        removedInner: this._removedInnerWindows,
      },
      shells: {
        added: this._addedShells,
        modified: this._modifiedShells,
        removed: this._removedShells,
      },
      compartments: {
        added: this._addedCompartments,
        removed: this._removedCompartments,
      },
      statistics: this._statistics,
    };
  },
};

////////////////////////////////////////////////////////////////////////////////
