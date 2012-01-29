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
 *  it's important to steal its code wherever possible.
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
 * - JS Compartments: live under "explicit/js/compartment(BLAH)" where BLAH
 *    always has front-slashes replaced by backslashes and is determined by
 *    GetCompartmentName in js/xpconnect/src/XPCJSRuntime.cpp:
 *   - "atoms": If the compartment is the default compartment for its runtime.
 *      Although it seems like this should happen multiple times (and be
 *      aggregated in about:memory), I'm not seeing it, suggesting it may be
 *      a one-off (or the jsprobes implementation screws up...)
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
 **/
