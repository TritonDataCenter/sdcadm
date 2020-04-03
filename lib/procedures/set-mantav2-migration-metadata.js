/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * This is a Procedure to set metadata on the "manta" SAPI application as
 * appropriate for beginning migration of a Mantav1 to a Mantav2.
 *
 * Basically this involves setting `MANTAV=2` plus a number of other boolean
 * metadata, such as `SNAPLINK_CLEANUP_REQUIRED=true`, as a signal to
 * subsequent migration steps.
 */

'use strict';

const assert = require('assert-plus');
const util = require('util');
const vasync = require('vasync');
const VError = require('verror');

const errors = require('../errors');
const Procedure = require('./procedure').Procedure;



// ---- internal support functions


// ---- the procedure

function SetMantav2MigrationMetadataProcedure() {
}
util.inherits(SetMantav2MigrationMetadataProcedure, Procedure);

SetMantav2MigrationMetadataProcedure.prototype.summarize =
function summarize() {
    return 'Set MANTAV=2 and other metadata on the "manta" SAPI application\n' +
        '    to mark the start of migration to mantav2';
};

SetMantav2MigrationMetadataProcedure.prototype.execute =
function execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');
    assert.object(opts.log, 'opts.log');

    const sdcadm = opts.sdcadm;
    const ui = opts.ui;

    vasync.pipeline({
        arg: {},
        funcs: [
            function getApp(ctx, next) {
                sdcadm.sapi.listApplications({
                    name: 'manta',
                    include_master: true
                }, function onApps(err, apps) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                    } else if (apps.length > 1) {
                        next(new VError('multiple "manta" apps found!'));
                    } else if (apps.length === 0) {
                        next(new VError('no "manta" application found'));
                    } else {
                        ctx.app = apps[0];
                        next();
                    }
                });
            },

            function setMetadata(ctx, next) {
                let update = {
                    // Current SAPI version implicitly assumes `include_master`
                    // for UpdateApplication (and others). It doesn't actually
                    // look at an `include_master` param.
                    //      include_master: true,
                    metadata: {
                        MANTAV: 2,

                        // Boolean metadata to mark the need for subsequent
                        // migration steps.
                        SNAPLINK_CLEANUP_REQUIRED: true,
                        MANTA_DELETE_LOG_CLEANUP_REQUIRED: true,
                        REPORTS_CLEANUP_REQUIRED: true,
                        ARCHIVED_JOBS_CLEANUP_REQUIRED: true,
                        MANTAV1_MPU_UPLOADS_CLEANUP_REQUIRED: true
                    }
                };

                sdcadm.sapi.updateApplication(ctx.app.uuid, update,
                    errors.sdcClientErrWrap(next, 'sapi'));
            },

            function letTheCallerKnow(_, next) {
                ui.info('Set mantav2 migration metadata (MANTAV=2, '
                    + 'SNAPLINK_CLEANUP_REQUIRED=true, etc.)');
                next();
            }
        ]
    }, cb);
};


// --- exports

module.exports = {
    SetMantav2MigrationMetadataProcedure: SetMantav2MigrationMetadataProcedure
};
