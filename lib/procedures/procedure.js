/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * A "Procedure" API for managing execution of some of the larger sdcadm tasks.
 * For smaller tasks encapsulated as a single function, see
 * "lib/steps/README.md".
 *
 * `sdcadm` has a number of "Procedure" subclasses for doing some larger task,
 * e.g. downloading images for an update, updating one of the simple stateless
 * core service instances, updating manatee. The expected usage is:
 *
 * 1. create an array of one or more procedure objects:
 *
 *      var procs = [new DownloadImages(...), new UpdateMoray(...)];
 *
 * 2. prepare the procedures, during which they gather necessary information
 *    from the system, error out if it cannot be accomplished, and callback
 *    with whether they have work to do:
 *
 *          vasync.forEachParallel({
 *              inputs: procs,
 *              func: function prepareProc(proc, nextProc) {
 *                  proc.prepare({
 *                      log: log,
 *                      ui: ui,
 *                      sdcadm: sdcadm
 *                  }, function onPrepare(err, nothingToDo) {
 *                      // ...
 *                  });
 *              }
 *          }, function (err) {
 *              // ...
 *          });
 *
 * 3. Use `.summarize(...)` for each procedure to show what will be done, and
 *    get confirmation from the operator before proceeding.
 *
 * 4. Call `.execute(...)` on each procedure in series.
 *
 * See `runProcs()` in "lib/procedures/index.js" for a method to handle this
 * usage.
 */

var assert = require('assert-plus');
var VError = require('verror');


// Create a procedure. All configuration defining a procedure should be
// passed into its constructor.
function Procedure(_opts) {}

// Prepare the procedure. This involves:
//
// - gathering necessary system data to determine the exact steps to perform,
// - calling back with an error if the procedure is not viable,
//   (e.g. if a requested server is not running, or a required service is down),
// - calling back with a boolean if the procedure has nothing to do (e.g. if
//   an image to download is already in the DC's IMGAPI, or a service to add
//   is already in SAPI)
//
// This will be called before `<procedure>.summarize`, so this provides an
// opportunity for the procedure to gather info necessary for a useful
// summary string.
//
// @param {Object} opts.log - Bunyan logger.
// @param {Object} opts.sdcadm
// @param {Object} opts.ui - see "lib/cli/ui.js".
// @param {Function} cb - `function (err, nothingToDo)`
//      `err` is null or is an Error with the reason(s) the procedure
//      (as configured) cannot be performed. If `err` is null, and the procedure
//      has nothing to do (the work has already been done), then `nothingToDo`
//      is `true`. If so, then the caller need not call its `execute`.
Procedure.prototype.prepare = function prepare(opts, cb) {
    assert.object(opts.log, 'opts.log');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');

    // By default a procedure is viable and should be executed.
    cb(null, false);
};

// @returns {String} A bullet point summary of work that will be done.
Procedure.prototype.summarize = function summarize() {};

// Execute the procedure.
//
// TODO: Spec the required `opts` for this. Currently there is a large
// mishmash used in SdcAdm.execUpdatePlan. This should be reduced. Odd
// params can come in via Procedure constructors.
Procedure.prototype.execute = function execute(opts, cb) {
    assert.object(opts.log, 'opts.log');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');  // Deprecated. Use `ui`.
    assert.object(opts.ui, 'opts.ui');

    cb(new VError({name: 'NotImplementedError'},
        this.constructor.name + '.execute() is not implemented'));
};


// ---- exports

module.exports = {
    Procedure: Procedure
};

// vim: set softtabstop=4 shiftwidth=4:
