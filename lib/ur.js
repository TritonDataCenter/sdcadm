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
var UrClient = require('urclient');
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

    // FIXME: modify to use sdcadm.ur
    var client = UrClient.create_ur_client({
        log: opts.log || opts.sdcadm.log,
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


/**
 * Return an Ur Client Run Queue ready to be started with rq.start(),
 * right after adding the desired servers using `rq.add_server(server)`.
 *
 * @param {Object} options: Options for the queue. See assertions below.
 * @param {Function} callback of the form f(err, results)
 */
function runQueue(options, callback) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.func(options.progress, 'options.progress');
    assert.optionalObject(options.progbar, 'options.progbar');
    assert.optionalString(options.get, 'options.get');
    assert.optionalString(options.put, 'options.put');
    assert.optionalString(options.dir, 'options.dir');
    assert.optionalString(options.command, 'options.command');

    var sdcadm = options.sdcadm;
    var log = options.log;
    var progress = options.progress;
    var bar = options.progbar;

    function info(msg) {
        return (bar) ? bar.log(msg) : progress(msg);
    }

    // Results for each node:
    var results = [];
    var opts = {
        urclient: sdcadm.ur,
        timeout: Math.floor(360 * 1000)
    };

    if (options.get) {
        opts.type = 'send_file';
        opts.src_file = options.get;
        opts.dst_dir = options.dir;
        opts.clobber = options.clobber || false;
    } else if (options.put) {
        opts.type = 'recv_file';
        opts.src_file = options.put;
        opts.dst_dir = options.dir;
    } else {
        opts.type = 'exec';
        opts.script = '#!/bin/bash\n\n' + options.command + '\n';
        opts.env = {
            // REVIEW: Use current user instead?
            PATH: process.env.PATH,
            HOME: '/root',
            LOGNAME: 'root',
            USER: 'root'
        };
    }

    var rq = UrClient.create_run_queue(opts);

    rq.on('dispatch', function onDispatch(server) {
        info(format('Ur running command on %s (%s)',
                server.uuid, server.hostname));
    });

    rq.on('success', function onSuccess(server, result) {
        var msg = format('Ur run ok on %s (%s)', server.uuid, server.hostname);
        info(msg);
        if (bar) {
            bar.advance(1);
        }
        var rr = {
            uuid: server.uuid,
            hostname: server.hostname
        };
        if (options.get || options.put) {
            rr.result = {
                stdout: 'ok',
                stderr: '',
                exit_status: 0
            };
        } else {
            rr.result = result;
        }
        results.push(rr);
        log.trace({results: rr}, msg);
        if (rq.count_outstanding() === 0 && rq.rq_pending.length === 0) {
            // This will fire the on('end') event:
            rq.close();
        }
    });

    rq.on('failure', function onFailure(server, error) {
        var msg = format('Ur error on %s (%s): %s', server.uuid,
                server.hostname, error.message);
        info(msg);
        if (error.stderr) {
            info('  :: stderr:\n' + error.stderr);
        }
        if (bar) {
            bar.advance(1);
        }
        log.error({err: error, server: server}, msg);

        var rr = {
            uuid: server.uuid,
            hostname: server.hostname
        };

        rr.error = {
            message: error.message,
            name: error.name,
            code: error.code || null
        };

        results.push(rr);
        if (rq.count_outstanding() === 0 && rq.rq_pending.length === 0) {
            // This will fire the on('end') event:
            rq.close();
        }
    });

    rq.on('end', function onEnd() {
        info('Ur command run complete');
        callback(null, results);
    });

    return (rq);
}



// ---- exports

module.exports = {
    runQueue: runQueue,
    execOnAllNodes: execOnAllNodes,
    exec: exec
};
