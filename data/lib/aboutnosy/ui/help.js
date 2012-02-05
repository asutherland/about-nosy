/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * UI widgets to display tab/origin/extension/subsystem/etc. summaries.
 **/

define(
  [
    'wmsy/wmsy',
    'text!./help.txt',
    'text!./help.css',
    'exports'
  ],
  function(
    $wmsy,
    $help_text,
    $_css,
    exports
  ) {

var wy = exports.wy =
  new $wmsy.WmsyDomain({id: "help", domain: "nosy", css: $_css});

wy.defineWidget({
  name: 'about',
  constraint: {
    type: 'about',
  },
  focus: wy.focus.item,
  structure: {
    label: "What am I looking at?",
    expandyText: "",
  },
  impl: {
    postInitUpdate: function() {
      this.collapsed = true;
      this.domNode.setAttribute("collapsed", this.collapsed);
    },
    toggleCollapsed: function() {
      this.collapsed = !this.collapsed;
      this.domNode.setAttribute("collapsed", this.collapsed);
      if (this.collapsed)
        this.expandyText_element.textContent = "";
      else
        this.expandyText_element.textContent = $help_text;
      this.FOCUS.bindingResized(this);
    },
  },
  events: {
    root: {
      command: function() {
        this.toggleCollapsed();
      },
    },
  },
});

}); // end define
