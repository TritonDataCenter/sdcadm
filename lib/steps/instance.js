/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018 Joyent, Inc.
 *
 * Steps for doing some things with Triton core instances.
 */

var assert = require('assert-plus');
var vasync = require('vasync');
var VError = require('verror');

var errors = require('../errors');


/*
 * Wait for the given instance metadatum value to be set, then return it.
 *
 * Dev Note: This doesn't fit the current "step" mold in that it calls back
 * with a value rather than setting results on the context `arg` like other
 * steps. See "lib/steps/README.md". This better fits one of the TODOs there
 * for having curried steps.
 */
function waitForVmInstanceMetadatum(args, cb) {
    assert.object(args, 'args');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.uuid(args.instanceUuid, 'args.instanceUuid');
    assert.string(args.metadataKey, 'args.metadataKey');
    assert.optionalFinite(args.timeoutMs, 'args.timeoutMs');
    assert.optionalFinite(args.intervalMs, 'args.intervalMs');
    assert.func(cb, 'cb');

    var intervalMs = args.intervalMs || 1000;
    var metadataValue;
    var start = Date.now();

    vasync.whilst(
        function shouldWeKeepGoing() {
            return (metadataValue === undefined);
        },
        function checkOnce(next) {
            if (args.timeoutMs && Date.now() - start > args.timeoutMs) {
                next(new VError(
                    'timeout (%dms) waiting for VM instance %s metadatum "%s"',
                    args.timeoutMs, args.instanceUuid, args.metadataKey));
                return;
            }

            args.sdcadm.vmapi.getVm({
                uuid: args.instanceUuid
            }, function (err, vm) {
                if (err) {
                    next(new errors.SDCClientError(err, 'vmapi'));
                } else if (vm.customer_metadata
                            .hasOwnProperty(args.metadataKey)) {
                    metadataValue = vm.customer_metadata[args.metadataKey];
                    next();
                } else {
                    setTimeout(next, intervalMs);
                }
            });
        },
        function whilstDone(err) {
            cb(err, metadataValue);
        }
    );
}


// --- exports

module.exports = {
    waitForVmInstanceMetadatum: waitForVmInstanceMetadatum
};

// vim: set softtabstop=4 shiftwidth=4:
