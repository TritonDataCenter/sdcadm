/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
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
var events = require('events');

var common = require('./common');
var errors = require('./errors');


var p = console.log;


/**
 * HACK: This uses `sdc-oneachnode` directly. That should be changed to use
 * urclient via sdcadm.getUrConnection().
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

    // FIXME: modify to use urclient via sdcadm.getUrConnection()
    var client = urclient.create_ur_client({
        log: opts.log || opts.sdcadm.log,
        amqp_config: opts.sdcadm.config.amqp,
        connect_timeout: (opts.connectTimeout === undefined ?
            5000 : opts.connectTimeout),
        enable_http: false
    });
    // Prevent issues with bunyan logger, console.log and other functions
    // trying to stringify the error messages comming from ur client, which
    // happen to include Circular references
    client.on('error', function (err) {
        if (err.urce_amqp) {
            delete err.urce_amqp;
        }
        if (err.urce_urconn) {
            delete err.urce_urconn;
        }
        return cb_(err);
    });
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
    common.assertStrictOptions('runQueue', options, {
        sdcadm: 'object',
        urConnection: 'object',
        log: 'object',
        progress: 'func',
        progbar: 'optionalObject',
        get: 'optionalString',
        put: 'optionalString',
        dir: 'optionalString',
        command: 'optionalString',
        concurrency: 'optionalNumber',
        timeout: 'number'
    });
    assert.func(callback, 'callback');

    var log = options.log;
    var progress = options.progress;
    var bar = options.progbar;

    function info(msg) {
        return (bar) ? bar.log(msg) : progress(msg);
    }

    // Results for each node:
    var results = [];
    var opts = {
        urclient: options.urConnection,
        timeout: options.timeout,
        concurrency: options.concurrency
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

    var rq = urclient.create_run_queue(opts);

    /*
     * Listen for errors on the connection to Ur.  If we receive an error,
     * we want to abort this RunQueue immediately.  Make sure we are not
     * the first error handler to attach, as this would change the error
     * handling behaviour of the program at large.
     */
    var aborter = function (err) {
        log.error({
            err: err
        }, 'ur error, aborting run queue');
        rq.abort();
    };
    assert.ok(events.EventEmitter.listenerCount(options.urConnection,
       'error') > 0);
    options.urConnection.on('error', aborter);

    rq.on('dispatch', function onDispatch(server) {
        log.debug(format('Ur running command on %s (%s)',
                server.uuid, server.hostname));
    });

    rq.on('success', function onSuccess(server, result) {
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
        log.trace({
            results: rr
        }, format('Ur run ok on %s (%s)', server.uuid, server.hostname));
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
    });

    rq.on('end', function onEnd() {
        options.urConnection.removeListener('error', aborter);
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
