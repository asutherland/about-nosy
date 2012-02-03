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
  new $wmsy.WmsyDomain({id: "app", domain: "nosy", css: $_css});

wy.defineWidget({
  name: "root",
  focus: wy.focus.domain.vertical(),
  constraint: {
    type: "root",
  },
  structure: {
  },
});

function NosyApp() {
  this.sampleCount = 30;
  this.sampleIntervalMS = 1000;

  this.frobConsumer = new $memfrobrep.MemFrobConsumer(
                        this.sampleCount, this.sampleIntervalMS);
  this._sendReq = null;
}
NosyApp.prototype = {
  _receive: function(msg) {
    if (msg.type === 'frobbed') {
      this.frobConsumer.consumeExplicitWireRep(msg.data);
    }
  },

  connect: function() {
    this._sendReq({ type: 'setInterval', intervalMS: this.sampleIntervalMS });
  },
};

function hookupChromeBridge(app) {
  app._sendReq = function(data) {
    var event = document.createEvent("MessageEvent");
    event.initMessageEvent('uiReq', false, false,
                           JSON.stringify(data), '*', null, null, null);
    window.dispatchEvent(event);
  };

  window.addEventListener('uiData', function(evt) {
    app._receive(JSON.parse(evt.data));
  }, false);
}

exports.main = function(doc) {
console.log("- main starting");
  var app = new NosyApp();
console.log("- app created");
  hookupChromeBridge(app);
console.log("- app bound to bridge");
  app.connect();
console.log("- app requested initial data");

  var rootObj = {
  };

  // bind the UI into existence.
  var binder = wy.wrapElement(doc.getElementById("body"));
  binder.bind({type: "root", obj: rootObj});
};
exports.main(document);

}); // end define
