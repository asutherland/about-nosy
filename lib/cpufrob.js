/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Use JSProbes to perform a cpu-top like functionality.
 **/

const { Cc, Ci, Cu, Cr, Cm } = require('chrome');
const $timers = require('timers'),
      $unload = require('unload');

var hasProbes = exports.hasProbes = false;
try {
  const probes = Cc["@mozilla.org/base/probes;1"]
                   .getService(Ci.nsIProbeService);
  hasProbes = exports.hasProbes = true;
}
catch(ex) {
}

////////////////////////////////////////////////////////////////////////////////
// Helper funcs from about-jsprobes.js

var activeHandlers = [], timerIntervalId = null;

function stopProbes() {
  if (!hasProbes)
    return;

  while (activeHandlers.length) {
    probes.removeHandler(activeHandlers.pop());
  }

  if (timerIntervalId !== null) {
    $timers.clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
}
$unload.when(stopProbes);

function NOP() {};
function execOnProbeThread(func, callback) {
  var execStr = func.toString();
  execStr = execStr.substring(execStr.indexOf("{") + 1,
                              execStr.lastIndexOf("}"));
  //console.log("asyncQuery", execStr);
  probes.asyncQuery(execStr, callback || NOP);
}

function registerProbe(probepoint, captureArgs, func) {
  var usingStr = "using(" + captureArgs.join(");using(") + ");";
  var execStr = func.toString();
  execStr = execStr.substring(execStr.indexOf("{") + 1,
                              execStr.lastIndexOf("}"));
  console.log("addHandler", usingStr, execStr);
  var cookie = probes.addHandler(probepoint, usingStr, execStr);
  activeHandlers.push(cookie);
}

function gatherDataFromProbeThreadPeriodically(intervalMS,
                                               probeThreadFunc,
                                               thisThreadProcessFunc,
                                               resetFunc) {
  timerIntervalId = $timers.setInterval(function() {
      execOnProbeThread(probeThreadFunc, thisThreadProcessFunc);
    }, intervalMS);
}

////////////////////////////////////////////////////////////////////////////////
// CPU probes

function jstopProbes() {
  execOnProbeThread(function() {
    var compartmentInfos = [],
        id, cinfo, startTime, endTime, idx, toSend;
  });

  // XXX milliseconds is a crappy granularity
  registerProbe(
    probes.JS_WILL_EXECUTE_SCRIPT,
    ["env.currentTimeUS", "context.compartment.id"],
    function() {
      id = context.compartment.id;
      startTime = env.currentTimeUS;
      //print("> " + id + " " + startTime);
      idx = compartmentInfos.indexOf(id);
      if (idx === -1) {
        cid = {
          id: id,
          depth: 1,
          enterStamp: startTime,
          tally: 0,
        };
        compartmentInfos.push(id);
        compartmentInfos.push(cid);
      }
      else {
        cid = compartmentInfos[idx + 1];
        if (++cid.depth === 1)
          cid.enterStamp = startTime;
      }
    });
  registerProbe(
    probes.JS_DID_EXECUTE_SCRIPT,
    ["env.currentTimeUS", "context.compartment.id"],
    function() {
      id = context.compartment.id;
      endTime = env.currentTimeUS;
      //print("< " + id + " " + endTime);
      idx = compartmentInfos.indexOf(id);
      cid = compartmentInfos[idx + 1];
      if (--cid.depth === 0) {
        cid.tally += endTime - cid.enterStamp;
      }
    });

  gatherDataFromProbeThreadPeriodically(
    1000,
    function onProbeThread() {
      toSend = [];
      for (idx = compartmentInfos.length - 1; idx >= 0; idx -= 2) {
        cid = compartmentInfos[idx];
        if (cid.tally) {
          toSend.push(cid.id);
          toSend.push(cid.tally);
        }
        // reap inactive things
        if (!cid.tally && !cid.depth) {
          compartmentInfos.splice(idx - 1, 2);
        }
        // zero tallies for active things
        else {
          cid.tally = 0;
        }
      }
      postMessage(toSend);
    },
    function onOurThread(e) {
      var compartments = [];
      cpuTallies = {
        compartments: compartments,
      };
      var sbits = [], vals = e.value;
      for (var i = 0; i < vals.length; i += 2) {
        compartments.push("0x" + vals[i].toString(16));
        compartments.push(vals[i+1]);
      }
    });
}

var frobCount = 0;
exports.startFrobbingCPU = function() {
  if (++frobCount === 1) {
    jstopProbes();
  }
};

exports.stopFrobbingCPU = function() {
  if (--frobCount === 0) {
    stopProbes();
  }
};

var cpuTallies = {};
/**
 * Return CPU tallies for the last 1-second interval-ish.  The JSProbes
 *  internals only process probes every 400ms, and we only ask every 1 second,
 *  so this will be clumpy and awkward and sad.
 */
exports.gimmeLastCPUTallies = function() {
  return cpuTallies;
};


////////////////////////////////////////////////////////////////////////////////
