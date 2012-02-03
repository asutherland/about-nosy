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
    './summaries',
    'text!./app.css',
    'exports'
  ],
  function(
    $wmsy,
    $memfrobrep,
    $ui_summaries,
    $_css,
    exports
  ) {

var wy = exports.wy =
  new $wmsy.WmsyDomain({id: "app", domain: "nosy", css: $_css});

wy.defineWidget({
  name: "root",
  focus: wy.focus.domain.vertical('tabs', 'origins', 'extensions',
                                  'subsystems'),
  constraint: {
    type: "root",
  },
  structure: {
    tabsLabel: "Tabs",
    tabs: wy.vertList({ type: 'summary' },
                      ['frobConsumer', 'tabsView']),

    originsLabel: "Origins",
    origins: wy.vertList({ type: 'summary' },
                         ['frobConsumer', 'originsView']),

    extensionsLabel: "Extensions",
    extensions: wy.vertList({ type: 'summary' },
                            ['frobConsumer', 'extensionsView']),

    subsystemsLabel: "Subsystems",
    subsystems: wy.vertList({ type: 'summary' },
                            ['frobConsumer', 'subsystemsView']),
  },
});

function NosyApp() {
  this.sampleCount = 30;
  this.sampleIntervalMS = 1000;

  this.frobConsumer = new $memfrobrep.MemFrobConsumer(
                        this.sampleCount, this.sampleIntervalMS);
// XXX DEBUG HACK!
window.frobber = this.frobConsumer;
  this._sendReq = null;
}
NosyApp.prototype = {
  _receive: function(msg) {
// XXX DEBUG HACK!
window.FROBBED = msg.data;
    if (msg.type === 'frobbed') {
      try {
        this.frobConsumer.consumeExplicitWireRep(msg.data);
      }
      catch(ex) {
        // (If we don't do this, then our screw-ups disappear into the ether.
        // The platform has come so far, and yet still has so far to go.)
        console.error("Exception in processing:", ex);
      }
    }
  },

  connect: function() {
    this._sendReq({ type: 'setInterval', intervalMS: this.sampleIntervalMS });
  },

  attachToUI: function(updateHelper) {
    this.frobConsumer._issueUiUpdate = updateHelper;
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
  var app = new NosyApp();
  hookupChromeBridge(app);

  // bind the UI into existence.
  var binder = wy.wrapElement(doc.getElementById("body"));
  binder.bind({type: "root", obj: app});

  var idSpace = binder.idSpace;
  app.attachToUI(//idSpace.updateUsingObject.bind(idSpace));
    function(space, obj) { console.log("updating", space, obj); idSpace.updateUsingObject(space, obj); });

  app.connect();
};
exports.main(document);

}); // end define
