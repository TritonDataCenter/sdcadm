/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * This is a Procedure to ensure the GZ has links to the manta-deployment
 * tools in the manta-deployment zone, e.g. "/opt/smartdc/bin/manta-adm".
 *
 * Note that this can only be done if there *is* a created instance of the
 * "manta" service. That provision might be happening as part of this
 * update however, so we cannot determine this until the `.execute()` step.
 */

'use strict';

const assert = require('assert-plus');
const fs = require('fs');
const util = require('util');
const vasync = require('vasync');
const VError = require('verror');

const errors = require('../errors');
const Procedure = require('./procedure').Procedure;



// ---- internal support functions

// `rm -f $filePath`
function rmForceSync(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch (_unlinkErr) {
        // do nothing
    }
}


// ---- the procedure

function EnsureMantaDeploymentGzLinksProcedure() {
}
util.inherits(EnsureMantaDeploymentGzLinksProcedure, Procedure);

EnsureMantaDeploymentGzLinksProcedure.prototype.summarize =
function summarize() {
    return 'ensure /opt/smartdc/bin/manta-* tools are setup';
};

EnsureMantaDeploymentGzLinksProcedure.prototype.execute =
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
            function theCurrServerUuid(ctx, next) {
                sdcadm.getCurrServerUuid(function (_, currServerUuid) {
                    ctx.currServerUuid = currServerUuid;
                    next();
                });
            },
            function getSvc(ctx, next) {
                sdcadm.sapi.listServices({
                    name: 'manta',
                    application_uuid: sdcadm.sdcApp.uuid
                }, function listSvcsCb(err, svcs) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                    } else if (svcs.length > 1) {
                        next(new VError('multiple "manta" services found!'));
                    } else if (svcs.length === 0) {
                        next(new VError('no "manta" service found on the ' +
                            '"sdc" SAPI application'));
                    } else {
                        ctx.svc = svcs[0];
                        next();
                    }
                });
            },

            // Find the "manta" service inst. There should be exactly one the
            // headnode (on which we are currently running).
            function getInst(ctx, next) {
                sdcadm.sapi.listInstances({
                    service_uuid: ctx.svc.uuid
                }, function listInstCb(err, insts) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                    } else if (!insts || insts.length === 0) {
                        ui.info('No "manta" instance was found, skipping ' +
                            'creation of GZ links for manta-* tools.');
                        next();
                    } else if (insts.length > 1) {
                        next(new VError(
                            'multiple "manta" instances were found'));
                    } else if (!insts[0].params.server_uuid) {
                        next(new VError(
                            '"manta" instance %s (%s) does not have ' +
                                '"params.server_uuid" set',
                            insts[0].uuid, insts[0].params.alias));
                    } else if (insts[0].params.server_uuid !==
                               ctx.currServerUuid) {
                        next(new VError(
                            '"manta" instance %s (%s) is not on this server: ' +
                                'server_uuid=%s, currServerUuid=%s',
                            insts[0].uuid,
                            insts[0].params.alias,
                            insts[0].params.server_uuid,
                            ctx.currServerUuid));
                    } else {
                        ctx.inst = insts[0];
                        next();
                    }
                });
            },

            // Create stubs in /opt/smartdc/bin/ to a few `manta-*` tools
            // in the manta-deployment zone.
            function createLinks(ctx, next) {
                if (!ctx.inst) {
                    next();
                    return;
                }

                let zoneBaseDir = '/zones/' + ctx.inst.uuid +
                    '/root/opt/smartdc/manta-deployment';

                // Remove any tools from a previous setup.
                rmForceSync('/opt/smartdc/bin/manta-login');
                rmForceSync('/opt/smartdc/bin/manta-adm');
                rmForceSync('/opt/smartdc/bin/manta-oneach');
                rmForceSync('/opt/smartdc/bin/mantav2-migrate');

                fs.writeFileSync(
                    '/opt/smartdc/bin/manta-login',
                    [
                        '#!/bin/bash',
                        'exec ' + zoneBaseDir + '/bin/manta-login "$@"'
                    ].join('\n'),
                    {
                        mode: 0o755
                    }
                );
                fs.writeFileSync(
                    '/opt/smartdc/bin/manta-adm',
                    [
                        '#!/bin/bash',
                        'exec ' + zoneBaseDir + '/build/node/bin/node ' +
                            zoneBaseDir + '/bin/manta-adm "$@"'
                    ].join('\n'),
                    {
                        mode: 0o755
                    }
                );
                fs.writeFileSync(
                    '/opt/smartdc/bin/manta-oneach',
                    [
                        '#!/bin/bash',
                        'exec ' + zoneBaseDir + '/build/node/bin/node ' +
                            zoneBaseDir + '/bin/manta-oneach "$@"'
                    ].join('\n'),
                    {
                        mode: 0o755
                    }
                );
                fs.writeFileSync(
                    '/opt/smartdc/bin/mantav2-migrate',
                    [
                        '#!/bin/bash',
                        'exec ' + zoneBaseDir + '/build/node/bin/node ' +
                            zoneBaseDir + '/bin/mantav2-migrate "$@"'
                    ].join('\n'),
                    {
                        mode: 0o755
                    }
                );
                ui.info('Wrote manta-deployment tool stubs (e.g. manta-adm)');

                let manpages;
                let mandir = zoneBaseDir + '/man/man1';
                try {
                    manpages = fs.readdirSync(mandir);
                } catch (readdirErr) {
                    next(new VError(readdirErr,
                        'could not read manta-deployment man dir'));
                    return;
                }
                for (let manpage of manpages) {
                    let link = '/opt/smartdc/man/man1/' + manpage;
                    let targ = mandir + '/' + manpage;
                    let lstats = null;
                    try {
                        lstats = fs.lstatSync(link);
                    } catch (_lstatErr) {
                        // do nothing
                    }
                    if (!lstats) {
                        ui.info('Creating symlink "%s" for "%s"', link, targ);
                        fs.symlinkSync(targ, link);
                    }
                }

                next();
            }
        ]
    }, cb);
};


// --- exports

module.exports = {
    EnsureMantaDeploymentGzLinksProcedure: EnsureMantaDeploymentGzLinksProcedure
};

// vim: set softtabstop=4 shiftwidth=4:
