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

wy.defineIdSpace('statvis', function(tab) { return tab.id; });

const oneMeg = 1024 * 1024;

wy.defineWidget({
  name: 'barvis',
  constraint: {
    type: 'statvis',
  },
  structure: {
  },
  idspaces: ['statvis'],
  impl: {
    postInit: function() {
      this._labelWidth = 28;
      this._width = 4 * this.obj.statKing.numPoints + this._labelWidth;
      this._height = 28;
      this._x = null;
      this._y = null;
      this._makeVis();
    },
    _megTextFunc: function(d) {
      return Math.floor(d / oneMeg) + "M";
    },
    _makeVis: function() {
      var statlog = this.obj, stats = statlog.stats;
      const w = 4, h = this._height, lw = this._labelWidth;

      var x = this._x = $d3.scale.linear()
        .domain([0, 1])
        .range([0, w]);
      var y = this._y = $d3.scale.linear()
        .domain([0, statlog.statKing.chartMax])
        .rangeRound([0, h]);

      var vis = this.vis = $d3.select(this.domNode).append("svg")
        .attr("width", this._width)
        .attr("height", this._height);

      this.yFunc = function(d) { return h - y(d); };

      var rectClass = this.__cssClassBaseName + "rect",
          maxLabelClass = this.__cssClassBaseName + "maxLabel",
          curLabelClass = this.__cssClassBaseName + "curLabel",
          selectMaxLabel = this.selectMaxLabel = "." + maxLabelClass,
          selectCurLabel = this.selectCurLabel = "." + curLabelClass;

      vis.selectAll("rect")
          .data(stats)
        .enter().append("rect")
          .attr("class", rectClass)
          .attr("x", function(d, i) { return lw + x(i); })
          .attr("y", this.yFunc)
          .attr("width", w - 1)
          .attr("height", y);

      // label!
      this.identityFunc = function(d) { return d; };
      vis.selectAll(selectMaxLabel)
          .data([statlog.statKing.chartMaxStr])
        .enter().append("text")
          .attr("class", maxLabelClass)
          .attr("x", lw - 2)
          .attr("y", 0)
          .attr("dy", 10)
          .attr("text-anchor", "end")
          .text(this.identityFunc);

      this.megTextFunc =
      vis.selectAll(selectCurLabel)
          .data([stats[0]])
        .enter().append("text")
          .attr("class", curLabelClass)
          .attr("x", lw - 2)
          .attr("y", h)
          .attr("text-anchor", "end")
          .text(this._megTextFunc);
    },
    _updateVis: function() {
      var statlog = this.obj, y = this._y;
      // refresh y-axis scale
      y.domain([0, statlog.statKing.chartMax]);

      this.vis.selectAll("rect")
        .data(statlog.stats)
        .attr("y", this.yFunc)
        .attr("height", y);

      this.vis.selectAll(this.selectMaxLabel)
        .data([statlog.statKing.chartMaxStr])
        .text(this.identityFunc);
      this.vis.selectAll(this.selectCurLabel)
        .data([statlog.stats[0]])
        .text(this._megTextFunc);
    },
    update: function(recursive) {
      this._updateVis();
      this.__update(recursive);
    },
  },
});

}); // end define
