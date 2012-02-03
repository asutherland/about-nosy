/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 *
 **/

define(
  [
    'wmsy/wmsy',
    'wmsy/opc/d3',
    'text!./statvis.css',
    'exports'
  ],
  function(
    $wmsy,
    $d3,
    $_css,
    exports
  ) {

var wy = exports.wy =
  new $wmsy.WmsyDomain({id: 'statvis', domain: 'nosy', css: $_css});

wy.defineIdSpace("statvis", function(tab) { return tab.id; });

}); // end define
