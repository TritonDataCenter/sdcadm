/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * A library to call the UR client (a la sdc-oneachnode).
 *
 * Dev Note: Eventually it would be good to support the full functionality
 * of ur-client/sdc-oneachnode.
 */

var assert = require('assert-plus');
var format = require('util').format;
var once = require('once');
var urclient = require('urclient');
var vasync = require('vasync');

var common = require('./common');
var errors = require('./errors');


var p = console.log;


/**
 * HACK: This uses `sdc-oneachnode` directly. That should be changed to use
 * urclient.
 *
 * Run the given script on all servers in the DC.
 *
 * @param opts {Object}
 *      - sdcadm {SdcAdm instance}
 *      - cmd {String} The command/script to run.
 *      - log {Bunyan Logger} Optional.
 * @param cb {Function} `function (err, result)`
 */
function execOnAllNodes(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.string(opts.cmd, 'opts.cmd');
    assert.optionalObject(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    var execOpts = {
        log: opts.log || opts.sdcadm.log,
        maxBuffer: 1024 * 1024, // lame limit to have
        argv: ['/opt/smartdc/bin/sdc-oneachnode', '-j', '-a', opts.cmd]
    };
    common.execFilePlus(execOpts, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }
        cb(null, JSON.parse(stdout));
    });
}

/**
 * Run a command on a given server (aka ur-client `exec`,
 * aka `sdc-oneacnode -n SERVER CMD`).
 *
 * @param opts {Object}
 *      - sdcadm {SdcAdm instance}
 *      - cmd {String} The command/script to run.
 *      - server {UUID} The UUID of the server on which to run.
 *      - log {Bunyan Logger} Optional.
 *      - connectTimeout {Number} Optional. Default 5s.
 *      - execTimeout {Number} Optional. Default 30s.
 * @param cb {Function} `function (err, result)`
 */
function exec(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.string(opts.cmd, 'opts.cmd');
    assert.string(opts.server, 'opts.server');
    assert.optionalObject(opts.log, 'opts.log');
    assert.optionalNumber(opts.connectTimeout, 'opts.connectTimeout');
    assert.func(cb, 'cb');
    var cb_ = once(cb);

    var client = urclient.create_ur_client({
        log: opts.log,
        amqp_config: opts.sdcadm.config.amqp,
        connect_timeout: (opts.connectTimeout === undefined ?
            5000 : opts.connectTimeout),
        enable_http: false
    });
    client.on('error', cb_);
    client.on('ready', function () {
        client.exec({
            script: opts.cmd,
            server_uuid: opts.server,
            timeout: (opts.execTimeout === undefined ?
                30 * 1000 : opts.execTimeout),
            env: {}
        }, function (err, result) {
            if (err) {
                cb_(err);
            } else if (result.exit_status !== 0) {
                cb_(new errors.InternalError({ message: format(
                    'error running "%s" on server "%s": %s',
                    opts.cmd, opts.server, result.stderr) }));
            } else {
                cb_(null, result.stdout);
            }
        });
    });
}



// ---- exports

module.exports = {
    execOnAllNodes: execOnAllNodes,
    exec: exec
};
