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
      $pagemod = require('page-mod'),
      $self = require('self'),
      $memfrob = require('./memfrob');

const TRUE_NOSY_URL = self.data.url('aboutNosy.html'),
      BRIDGE_SCRIPT_URL = self.data.url('bridge.js');

function newClient(uiWorker) {
}

function deadClient(uiWorker) {
}

exports.main = function() {
  // - create the about:nosy mapping
  $protocol.about('nosy', {
    onRequest: function(request, response) {
      // this will still look like about:nosy in the URL bar, but the
      //  data comes from the "resource://" path.
      response.uri = TRUE_NOSY_URL;
    }
  });

  // - create the page-mod communication bridge
  pageMod.PageMod({
    include: ['about:nosy'],
    contentScriptWhen: 'start',
    contentSCriptFile: BRIDGE_SCRIPT_URL,
    onAttach: function onAttach(uiWorker) {
      var frobber = new $memfrob.MemTreeFrobber();

      newClient(uiWorker);

      uiWorker.on('uiReq', function(message) {
      });

      uiWorker.on('detach', function() {
        deadClient(uiWorker);
      });
    },
  });
};
