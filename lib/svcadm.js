/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent Inc.
 */

/*
 * A library to exec `svcadm` commands.
 */

var format = require('util').format;

var assert = require('assert-plus');

var common = require('./common');
var execFilePlus = common.execFilePlus;
var errors = require('./errors');
var InternalError = errors.InternalError;
var ur = require('./ur');

/**
 * Call `svcadm <command> FMRI`.
 *
 * @param args {Object}
 *      - fmri {Array | String} Optional. The SMF service FMRI(s) to enable,
 *      disable, restart.
 *      - wait {Boolean} Optional. Set to true to wait for each service to
 *        enter 'enabled'/'disabled' or 'degraded' state. Corresponds to '-s'
 *        option to `svcadm enable|disable`.
 *      - zone {String} Optional. Administer services in the specified zone.
 *        Only valid if called from the global zone.
 *      - verbose {Boolean} Optional. Verbose stdout output.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 * @param cb {Function} `function (err)`
 */

function svcadm(cmd, args, cb) {
    assert.string(cmd, 'cmd');
    var cmds = ['enable', 'disable', 'restart', 'refresh'];
    if (cmds.indexOf(cmd) === -1) {
        cb(new InternalError({
            message: format('Unknown svcadm %s command', cmd)
        }));
        return;
    }
    assert.object(args, 'args');
    var fmri = (args.fmri && !Array.isArray(args.fmri) ?
            [args.fmri] : args.fmri);
    assert.optionalArrayOfString(fmri, 'args.fmri');
    assert.optionalBool(args.wait, 'args.wait');
    assert.optionalString(args.zone, 'args.zone');
    assert.optionalBool(args.verbose, 'args.verbose');
    assert.object(args.log, 'args.log');
    assert.func(cb);

    assert.optionalString(args.server_uuid, 'args.server_uuid');
    assert.optionalObject(args.sdcadm, 'args.sdcadm');

    var argv = ['/usr/sbin/svcadm'];
    if (args.zone) {
        argv.push('-z');
        argv.push(args.zone);
    }
    if (args.verbose) {
        argv.push('-v');
    }
    argv.push(cmd);
    if (args.wait && (cmd !== 'restart' && cmd !== 'refresh')) {
        argv.push('-s');
    }
    if (fmri.length) {
        argv = argv.concat(fmri);
    }

    if (args.server_uuid) {
        ur.exec({
            log: args.log,
            sdcadm: args.sdcadm,
            cmd: argv.join(' '),
            server: args.server_uuid
        }, function (err, result) {
            cb(err);
        });
    } else {
        execFilePlus({argv: argv, log: args.log}, cb);
    }
}


/**
 * Call `svcadm enable FMRI`.
 *
 * @param args {Object}
 *      - fmri {Array | String} Optional. The SMF service FMRI(s) to enable.
 *      - wait {Boolean} Optional. Set to true to wait for each service to
 *        enter 'enabled' or 'degraded' state. Corresponds to '-s' option to
 *        `svcadm enable`.
 *      - zone {String} Optional. Administer services in the specified zone.
 *        Only valid if called from the global zone.
 *      - verbose {Boolean} Optional. Verbose stdout output.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 * @param cb {Function} `function (err)`
 */
function svcadmEnable(args, cb) {
    return svcadm('enable', args, cb);
}


/**
 * Call `svcadm disable FMRI`.
 *
 * @param args {Object}
 *      - fmri {Array | String} Optional. The SMF service FMRI(s) to disable.
 *      - wait {Boolean} Optional. Set to true to wait for each service to
 *        enter 'disabled' state. Corresponds to '-s' option to
 *        `svcadm disable`.
 *      - zone {String} Optional. Administer services in the specified zone.
 *        Only valid if called from the global zone.
 *      - verbose {Boolean} Optional. Verbose stdout output.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 * @param cb {Function} `function (err)`
 */
function svcadmDisable(args, cb) {
    return svcadm('disable', args, cb);
}


function svcadmRestart(args, cb) {
    return svcadm('restart', args, cb);
}

function svcadmRefresh(args, cb) {
    return svcadm('refresh', args, cb);
}

function restartHermes(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');

    var svc, inst;
    opts.sdcadm.sapi.listServices({
        name: 'sdc'
    }, function (svcErr, svcs) {
        if (svcErr) {
            cb(svcErr);
            return;
        }
        if (!svcs.length) {
            cb(new errors.SDCClientError(new Error(
                'Cannot find sdc service'), 'sapi'));
            return;
        }
        svc = svcs[0];
        opts.sdcadm.sapi.listInstances({
            service_uuid: svc.uuid
        }, function (instErr, insts) {
            if (instErr) {
                cb(instErr);
                return;
            }

            if (!insts.length) {
                cb(new errors.SDCClientError(new Error(
                    'Unable to find sdc instance'), 'sapi'));
                return;
            }
            // Assume we just have a single sdc instance for now:
            inst = insts[0];
            var hermesOpts = {
                fmri: 'hermes',
                zone: inst.uuid,
                log: opts.log
            };
            opts.sdcadm.vmapi.getVm({
                uuid: inst.uuid
            }, function getVmCb(getVmErr, vm) {
                if (getVmErr) {
                    cb(new errors.SDCClientError(new Error(
                        'Unable to find sdc VM'), 'vmapi'));
                    return;
                }
                opts.sdcadm.getCurrServerUuid(function gCsCb(_, serverUuid) {
                    // No need to use Ur if we're running sdcadm from the same
                    // server the sdc instance is running:
                    if (serverUuid !== vm.server_uuid) {
                        hermesOpts.server_uuid = vm.server_uuid;
                    }
                    svcadmRestart(hermesOpts, cb);
                });

            });
        });
    });
}

// ---- exports

module.exports = {
    svcadmEnable: svcadmEnable,
    svcadmDisable: svcadmDisable,
    svcadmRestart: svcadmRestart,
    svcadmRefresh: svcadmRefresh,
    restartHermes: restartHermes
};
