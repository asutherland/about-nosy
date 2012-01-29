/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The wmsy UI for about:nosy
 **/

define(
  [
    'wmsy/wmsy',
    'aboutnosy/memfrobrep',
    'text!./app.css',
    'exports'
  ],
  function(
    $wmsy,
    $memfrobrep,
    $_css,
    exports
  ) {

var wy = exports.wy =
  new $wmsy.WmsyDomain({id: "app", domain: "app", css: $_css});

function NosyApp() {


}
NosyApp.prototype = {
};

function hookupChromeBridge() {
}

exports.main = function(doc) {
  var app = new NosyApp();

  var rootObj = {
  };

  // bind the UI into existence.
  var binder = wy.wrapElement(doc.getElementById("body"));
  binder.bind({type: "root", obj: rootObj});
};

}); // end define
