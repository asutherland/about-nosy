/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The startup/setup logic for the about:nosy extension as a whole.  We:
 *
 * - Create the "about:nosy" handler which gets mapped to data/aboutnosy.html,
 *    a page that runs without any privileges but does get a comm bridge.
 * - Create a pagemod handler for about:nosy that establishes a comm bridge
 *    that is how it requests and gets its data.  The design intent is to both
 *    allow this mechanism to work under electrolysis and to be able to send
 *    the data over the wire to a completely different machine, etc.
 *
 * Important notes:
 *
 * - Data collection only occurs when an "about:nosy" page is being displayed.
 **/

const $protocol = require('./jetpack-protocol/index'),
      $pageMod = require('page-mod'),
      $timers = require('timers'),
      $self = require('self'),
      $memfrob = require('./memfrob'),
      $cpufrob = require('./cpufrob');

const TRUE_NOSY_URL = $self.data.url('aboutNosy.html'),
      PRINCIPAL_URI = "resource://jid1-o23hsujp6n0lva", //$self.data.url(''),
      BRIDGE_SCRIPT_URL = $self.data.url('bridge.js');

var nosyClients = [];

function NosyClient(uiWorker) {
  nosyClients.push(this);

  uiWorker.port.on('uiReq', this.onMessage.bind(this));
  uiWorker.on('detach', this.onDetach.bind(this));

  this.uiWorker = uiWorker;
  this._memFrobber = null;
  this._interval = null;

  this.initialized = false;
  this._deferredMessages = [];
  $memfrob.ExtensionsKing.gatherInfoAboutAddons(
    this._processDeferred.bind(this));
}
NosyClient.prototype = {
  _processDeferred: function() {
    this.initialized = true;
    // this is a hack because we lack promises, roughly.
    for (var i = 0; i < this._deferredMessages.length; i++) {
      this.onMessage(this._deferredMessages[i]);
    }
    this._deferredMessages = null;
  },

  _msg_setInterval: function(msg) {
    if (!this._memFrobber) {
      this._memFrobber = new $memfrob.MemTreeFrobber();
      if ($cpufrob.hasProbes) {
        $cpufrob.startFrobbingCPU();
      }
    }

    this.onInterval();

    if (this._interval != null);
      $timers.clearInterval(this._interval);
    this._interval = $timers.setInterval(this.onInterval.bind(this),
                                         msg.intervalMS);
  },

  onInterval: function() {
    var sampledAt = Date.now(),
        explicitTree = $memfrob.gatherExplicitTree(),
        wireRep = this._memFrobber.processExplicitTree(explicitTree, sampledAt),
        cpuTallies = null;
    if ($cpufrob.hasProbes)
      cpuTallies = $cpufrob.gimmeLastCPUTallies();
    this.uiWorker.port.emit('uiData',
                            {
                              type: 'frobbed',
                              mem: wireRep,
                              cpu: cpuTallies
                            });
  },

  onMessage: function(msg) {
    if (!this.initialized) {
      this._deferredMessages.push(msg);
      return;
    }

    var func = this['_msg_' + msg.type];
    func.call(this, msg);
  },

  onDetach: function() {
    var index = nosyClients.indexOf(this);
    nosyClients.splice(index, 1);

    if (this._interval != null) {
      $timers.clearInterval(this._interval);
      this._interval = null;

      if ($cpufrob.hasProbes)
        $cpufrob.stopFrobbingCPU();
    }
  },
};

var nosyProtocol;

exports.main = function() {
  // - create the about:nosy mapping
  nosyProtocol = $protocol.about('nosy', {
    onRequest: function(request, response) {
      // this will still look like about:nosy in the URL bar, but the
      //  data comes from the "resource://" path.
      response.uri = TRUE_NOSY_URL;
      // XXX try commenting this out once things are werkin', the redirect may
      //  already be dealing with the principal issue for us, but I don't want
      //  the extra variable yet.
      response.principalURI = TRUE_NOSY_URL; //PRINCIPAL_URI;
    }
  });
  nosyProtocol.register();

  // - create the page-mod communication bridge
  $pageMod.PageMod({
    include: ['about:nosy', TRUE_NOSY_URL],
    contentScriptWhen: 'start',
    contentScriptFile: BRIDGE_SCRIPT_URL,
    onAttach: function onAttach(uiWorker) {
      new NosyClient(uiWorker);
    },
  });
};
