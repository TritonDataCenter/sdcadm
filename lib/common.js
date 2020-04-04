/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var child_process = require('child_process'),
    exec = child_process.exec,
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var format = require('util').format;
var fs = require('fs');
var netconfig = require('triton-netconfig');
var path = require('path');
var tty = require('tty');
var util = require('util');
var vasync = require('vasync');
var backoff = require('backoff');
var once = require('once');
var sprintf = require('extsprintf').sprintf;
var VError = require('verror');

var errors = require('./errors');
var InternalError = errors.InternalError;

// --- globals

var DEFAULTS_PATH = path.resolve(__dirname, '..', 'etc', 'defaults.json');
var CONFIG_PATH = '/var/sdcadm/sdcadm.conf';

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

var SECONDS = 1000;

/*
 * A map of abstract network types to functions that can be used to identify
 * those types. Used below in validateNetType, netTypeToNetFunc, and
 * netTypeToNicFunc.
 *
 * Note that the functions from the netconfig library use the network's nic tag
 * to identify the network as admin, external, or manta, so the abstract network
 * types in the map correspond to nic tags, not network names.
 */
var NETWORK_FUNC_MAP = {
    'admin': {
        netFunc: netconfig.isNetAdmin,
        nicFunc: netconfig.isNicAdmin
    },
    'external': {
        netFunc: netconfig.isNetExternal,
        nicFunc: netconfig.isNicExternal
    },
    'manta': {
        netFunc: netconfig.isNetManta,
        nicFunc: netconfig.isNicManta
    }
};

// --- exports

/*
 * Assert that "opts", a named parameter object passed to a function,
 * contains no properties other than those expected by the software.    The
 * "expected" parameter is a map from expected property name to the type
 * checking function in the "assert-plus" module.  Properties with values of
 * the incorrect type, or unexpected extra properties, will cause the
 * function to throw.
 */
function assertStrictOptions(funcname, opts, expected) {
    assert.string(funcname, 'funcname');
    assert.object(opts, funcname + ': opts');
    assert.object(expected, funcname + ': expected');

    var unexpected = [];

    for (var k in opts) {
        if (!opts.hasOwnProperty(k)) {
            continue;
        }

        var e = expected[k];
        if (!e) {
            unexpected.push(k);
            continue;
        }

        var afunc = assert[e];
        assert.func(afunc, 'invalid assertion type: ' + e);
        afunc(opts[k], 'opts.' + k);
    }

    if (unexpected.length > 0) {
        throw (new Error(funcname + ': unexpected options: ' +
            unexpected.join(', ')));
    }
}


function objCopy(obj, target) {
    if (!target) {
        target = {};
    }
    Object.keys(obj).forEach(function (k) {
        target[k] = obj[k];
    });
    return target;
}


/**
 * Load sdcadm config.
 *
 * Dev Notes: We load from /usbkey/config to avoid needing SAPI up to run
 * sdcadm (b/c eventually sdcadm might drive bootstrapping SAPI). This *does*
 * unfortunately perpetuate the split-brain between /usbkey/config and
 * metadata on the SAPI 'sdc' application. This also does limit `sdcadm`
 * usage to the headnode GZ (which is fine for now).
 */
function loadConfig(options, cb) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(cb, 'cb');
    var log = options.log;

    var config = {};
    vasync.pipeline({funcs: [
        function loadDefaults(_, next) {
            log.trace({DEFAULTS_PATH: DEFAULTS_PATH}, 'load default config');
            fs.readFile(DEFAULTS_PATH, {encoding: 'utf8'},
                    function (err, data) {
                if (err) {
                    // TODO: InternalError
                    next(err);
                    return;
                }
                config = JSON.parse(data);  // presume no parse error
                next();
            });
        },
        function loadConfigPath(_, next) {
            fs.exists(CONFIG_PATH, function (exists) {
                if (!exists) {
                    next();
                    return;
                }
                log.trace({CONFIG_PATH: CONFIG_PATH}, 'load config file');
                fs.readFile(CONFIG_PATH, {encoding: 'utf8'},
                        function (err, data) {
                    if (err) {
                        // TODO: ConfigError
                        next(err);
                        return;
                    }
                    try {
                        config = objCopy(JSON.parse(data), config);
                    } catch (parseErr) {
                        // TODO: ConfigError
                        next(parseErr);
                        return;
                    }
                    next();
                });
            });
        },
        function loadSdcConfig(_, next) {
            var cmd = '/usr/bin/bash /lib/sdc/config.sh -json';
            log.trace({cmd: cmd}, 'load SDC config');
            exec(cmd, function (err, stdout, stderr) {
                if (err) {
                    next(new InternalError({
                        message:
                            'could not load configuration from /usbkey/config',
                        cmd: cmd,
                        stderr: stderr,
                        cause: err
                    }));
                    return;
                }
                var sdcConfig;
                try {
                    sdcConfig = JSON.parse(stdout);
                } catch (parseErr) {
                    next(new InternalError({
                        message: 'unexpected /usbkey/config content',
                        cause: parseErr
                    }));
                    return;
                }

                config.dns_domain = sdcConfig.dns_domain;
                config.datacenter_name = sdcConfig.datacenter_name;
                config.ufds_admin_uuid = sdcConfig.ufds_admin_uuid;
                config.coal = sdcConfig.coal;
                config.assets_admin_ip = sdcConfig.assets_admin_ip;
                config.datacenter_location = sdcConfig.datacenter_location;
                config.admin_ip = sdcConfig.admin_ip;
                config.external_ip = sdcConfig.external_ip;
                config.datacenter_company_name =
                    sdcConfig.datacenter_company_name;

                // Calculated config.
                var dns = config.datacenter_name + '.' + config.dns_domain;
                config.papi = {
                    url: format('http://papi.%s', dns)
                };
                config.vmapi = {
                    url: format('http://vmapi.%s', dns)
                };
                config.sapi = {
                    url: format('http://sapi.%s', dns)
                };
                config.cnapi = {
                    url: format('http://cnapi.%s', dns)
                };
                config.imgapi = {
                    url: format('http://imgapi.%s', dns)
                };
                config.napi = {
                    url: format('http://napi.%s', dns)
                };
                config.wfapi = {
                    url: format('http://workflow.%s', dns)
                };
                config.ufds = {
                    url: format('ldaps://ufds.%s', dns),
                    bindDN: sdcConfig.ufds_ldap_root_dn,
                    bindPassword: sdcConfig.ufds_ldap_root_pw
                };

                var amqpInfo = sdcConfig.rabbitmq.split(':');
                config.amqp = {
                    login: amqpInfo[0],
                    password: amqpInfo[1],
                    host: sdcConfig.rabbitmq_domain,
                    port: +amqpInfo[3]
                };

                next();
            });
        }
    ]}, function done(err) {
        cb(err, config);
    });
}


function deepObjCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}


/**
 * Attempt to split string into the given chars sub-sets
 *
 * @params str {String}
 *
 * @return {Array} of strings
 */
function splitStr(str, len) {
    if (!len) {
        len = 80;
    }
    var curr = len;
    var prev = 0;
    var output = [];
    while (str[curr]) {
        if (str[curr++] === ' ') {
            output.push(str.substring(prev, curr).trim());
            prev = curr;
            curr += len;
        }
    }
    output.push(str.substring(prev).trim());
    return output;
}

function cmp(a, b) {
    if (a > b) {
        return 1;
    } else if (a < b) {
        return -1;
    } else {
        return 0;
    }
}


/**
 * Prompt a user for a y/n answer.
 *
 *      cb('y')        user entered in the affirmative
 *      cb('n')        user entered in the negative
 *      cb(false)      user ^C'd
 *
 * Dev Note: This function should probably use Node's readline module rather
 * than doing its own terminal/character handling. See the following for some
 * potential use cases to test if making that change:
 *      https://gist.github.com/trentm/3bec297455cb1786be3e3264d551ff82
 */
function promptYesNo(opts_, cb) {
    assert.object(opts_, 'opts');
    assert.string(opts_.msg, 'opts.msg');
    assert.optionalString(opts_.default, 'opts.default');
    var opts = objCopy(opts_);

    // Setup stdout and stdin to talk to the controlling terminal if
    // process.stdout or process.stdin is not a TTY.
    var stdout;
    if (opts.stdout) {
        stdout = opts.stdout;
    } else if (process.stdout.isTTY) {
        stdout = process.stdout;
    } else {
        opts.stdout_fd = fs.openSync('/dev/tty', 'r+');
        stdout = opts.stdout = new tty.WriteStream(opts.stdout_fd);
    }
    var stdin;
    if (opts.stdin) {
        stdin = opts.stdin;
    } else if (process.stdin.isTTY) {
        stdin = process.stdin;
    } else {
        opts.stdin_fd = fs.openSync('/dev/tty', 'r+');
        stdin = opts.stdin = new tty.ReadStream(opts.stdin_fd);
    }

    stdout.write(opts.msg);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    var input = '';
    stdin.on('data', onData);

    function postInput() {
        stdout.write('\n');
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
    }

    function finish(rv) {
        if (opts.stdout_fd !== undefined) {
            stdout.end();
            delete opts.stdout_fd;
        }
        if (opts.stdin_fd !== undefined) {
            stdin.end();
            delete opts.stdin_fd;
        }
        cb(rv);
    }

    function onData(ch) {
        ch = ch + '';

        switch (ch) {
        case '\n':
        case '\r':
        case '\u0004':
            // They've finished typing their answer
            postInput();
            var answer = input.toLowerCase();
            if (answer === '' && opts.default) {
                finish(opts.default);
            } else if (answer === 'yes' || answer === 'y') {
                finish('y');
            } else if (answer === 'no' || answer === 'n') {
                finish('n');
            } else {
                stdout.write('Please enter "y", "yes", "n" or "no".\n');
                promptYesNo(opts, cb);
                return;
            }
            break;
        case '\u0003':
            // Ctrl C
            postInput();
            finish(false);
            break;
        case '\u007f': // DEL
            input = input.slice(0, -1);
            stdout.clearLine();
            stdout.cursorTo(0);
            stdout.write(opts.msg);
            stdout.write(input);
            break;
        default:
            // More plaintext characters
            stdout.write(ch);
            input += ch;
            break;
        }
    }
}

/**
 * Interactively prompt the user for a confirmation string.
 *
 *      cb(true)       The user entered the confirmation string.
 *      cb(false)      The user ^C'd.
 *
 * Dev Note: This function should probably use Node's readline module rather
 * than doing its own terminal/character handling. See the following for some
 * potential use cases to test if making that change:
 *      https://gist.github.com/trentm/3bec297455cb1786be3e3264d551ff82
 */
function promptConfirm(opts_, cb) {
    assert.object(opts_, 'opts');
    assert.string(opts_.msg, 'opts.msg');
    assert.string(opts_.confirmationStr, 'opts.confirmationStr');
    var opts = objCopy(opts_);

    // Setup stdout and stdin to talk to the controlling terminal if
    // process.stdout or process.stdin is not a TTY.
    var stdout;
    if (opts.stdout) {
        stdout = opts.stdout;
    } else if (process.stdout.isTTY) {
        stdout = process.stdout;
    } else {
        opts.stdout_fd = fs.openSync('/dev/tty', 'r+');
        stdout = opts.stdout = new tty.WriteStream(opts.stdout_fd);
    }
    var stdin;
    if (opts.stdin) {
        stdin = opts.stdin;
    } else if (process.stdin.isTTY) {
        stdin = process.stdin;
    } else {
        opts.stdin_fd = fs.openSync('/dev/tty', 'r+');
        stdin = opts.stdin = new tty.ReadStream(opts.stdin_fd);
    }

    stdout.write(opts.msg);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    var input = '';
    stdin.on('data', onData);

    function postInput() {
        stdout.write('\n');
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
    }

    function finish(rv) {
        if (opts.stdout_fd !== undefined) {
            stdout.end();
            delete opts.stdout_fd;
        }
        if (opts.stdin_fd !== undefined) {
            stdin.end();
            delete opts.stdin_fd;
        }
        cb(rv);
    }

    function onData(ch) {
        ch = ch + '';

        switch (ch) {
        case '\n':
        case '\r':
        case '\u0004':
            // They've finished typing their answer
            postInput();
            var answer = input.toLowerCase();
            if (answer === opts.confirmationStr) {
                finish(true);
            } else {
                stdout.write(`Please enter "${opts.confirmationStr}" to ` +
                    'confirm, or Ctrl+C to abort.\n\n');
                promptConfirm(opts, cb);
                return;
            }
            break;
        case '\u0003':
            // Ctrl C
            postInput();
            finish(false);
            break;
        case '\u007f': // DEL
            input = input.slice(0, -1);
            stdout.clearLine();
            stdout.cursorTo(0);
            stdout.write(opts.msg);
            stdout.write(input);
            break;
        default:
            // More plaintext characters
            stdout.write(ch);
            input += ch;
            break;
        }
    }
}


/* TODO(trentm): drop in favour of one from tabula module */
function sortArrayOfObjects(items, fields) {
    function _cmp(a, b) {
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        var invert = false;
        if (field[0] === '-') {
            invert = true;
            field = field.slice(1);
        }
        assert.ok(field.length, 'zero-length sort field: ' + fields);
        var a_cmp = Number(a[field]);
        var b_cmp = Number(b[field]);
        if (isNaN(a_cmp) || isNaN(b_cmp)) {
            a_cmp = a[field];
            b_cmp = b[field];
        }
        // Comparing < or > to `undefined` with any value always returns false.
        if (a_cmp === undefined && b_cmp === undefined) {
            /* jsl:pass */
            // PEDRO: This shouldn't be here then, it's returning the next
            // block. Consider removing then.
        } else if (a_cmp === undefined) {
            return (invert ? 1 : -1);
        } else if (b_cmp === undefined) {
            return (invert ? -1 : 1);
        } else if (a_cmp < b_cmp) {
            return (invert ? 1 : -1);
        } else if (a_cmp > b_cmp) {
            return (invert ? -1 : 1);
        }
      }
      return 0;
    }
    items.sort(_cmp);
}


function indent(s, indentation) {
    var x;

    switch (typeof (indentation)) {
    case 'number':
        assert.ok(!isNaN(indentation) && indentation >= 0);
        x = '';
        while (x.length < indentation) {
            x += ' ';
        }
        break;

    default:
        assert.optionalString(indentation, 'indentation');
        if (indentation) {
            x = indentation;
        } else {
            x = '    ';
        }
        break;
    }

    return (x + s.split(/\r?\n/g).join('\n' + x));
}


/**
 * A convenience wrapper around `child_process.execFile` to take away some
 * logging and error handling boilerplate.
 *
 * Warning: Avoid using this. Use `spawnRun` instead because it avoids the
 * overrun-maxBuffer problem.
 *
 * @param args {Object}
 *      - argv {Array} Required.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 *      - maxBuffer {Number}
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `errors.InternalError` wrapper around the child_process error.
 */
function execFilePlus(args, cb) {
    assert.object(args, 'args');
    assert.arrayOfString(args.argv, 'args.argv');
    assert.optionalNumber(args.maxBuffer, 'args.maxBuffer');
    assert.object(args.log, 'args.log');
    assert.func(cb);
    var argv = args.argv;

    args.log.trace({exec: true, argv: argv}, 'exec start');
    var execOpts = {};
    if (args.maxBuffer) {
        execOpts.maxBuffer = args.maxBuffer;
    }

    if (args.cwd) {
        execOpts.cwd = args.cwd;
    }

    execFile(argv[0], argv.slice(1), execOpts, function (err, stdout, stderr) {
        args.log.trace({exec: true, argv: argv, err: err, stdout: stdout,
            stderr: stderr}, 'exec done');
        if (err) {
            var msg = format(
                'exec error:\n'
                + '\targv: %j\n'
                + '\texit status: %s\n'
                + '\tstdout:\n%s\n'
                + '\tstderr:\n%s',
                argv, err.code, stdout.trim(), stderr.trim());
            cb(new errors.InternalError({message: msg, cause: err}),
               stdout, stderr);
        } else {
            cb(null, stdout, stderr);
        }
    });
}


/**
 * Convenience wrapper around `child_process.exec`, mostly oriented to
 * run commands using pipes w/o having to deal with logging/error handling.
 *
 * @param args {Object}
 *      - cmd {String} Required. The command to run.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 *      - opts {Object} Optional. child_process.exec execution Options.
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `errors.InternalError` wrapper around the child_process error.
 */
function execPlus(args, cb) {
    assert.object(args, 'args');
    assert.string(args.cmd, 'args.cmd');
    assert.object(args.log, 'args.log');
    assert.optionalObject(args.opts, 'args.opts');
    assert.func(cb);

    var cmd = args.cmd;
    var execOpts = args.opts || {};
    var log = args.log;

    log.trace({exec: true, cmd: cmd}, 'exec start');
    exec(cmd, execOpts, function execPlusCb(err, stdout, stderr) {
        log.trace({exec: true, cmd: cmd, err: err, stdout: stdout,
            stderr: stderr}, 'exec done');
        if (err) {
            var msg = format(
                'exec error:\n'
                + '\tcmd: %s\n'
                + '\texit status: %s\n'
                + '\tstdout:\n%s\n'
                + '\tstderr:\n%s',
                cmd, err.code, stdout.trim(), stderr.trim());
            cb(new errors.InternalError({message: msg, cause: err}),
               stdout, stderr);
        } else {
            cb(null, stdout, stderr);
        }
    });

}



/**
 * Run a command via `spawn` and callback with the results a la `execFile`.
 *
 * @param args {Object}
 *      - argv {Array} Required.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 *      - opts {Object} Optional `child_process.spawn` options.
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `errors.InternalError` wrapper around the child_process error.
 */
function spawnRun(args, cb) {
    assert.object(args, 'args');
    assert.arrayOfString(args.argv, 'args.argv');
    assert.ok(args.argv.length > 0, 'argv has at least one arg');
    assert.object(args.log, 'args.log');
    assert.func(cb);

    args.log.trace({exec: true, argv: args.argv}, 'exec start');
    var child = spawn(args.argv[0], args.argv.slice(1), args.opts);

    var stdout = [];
    var stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (chunk) { stdout.push(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (chunk) { stderr.push(chunk); });

    child.on('close', function spawnClose(code, signal) {
        stdout = stdout.join('');
        stderr = stderr.join('');
        args.log.trace({exec: true, argv: args.argv, code: code,
            signal: signal, stdout: stdout, stderr: stderr}, 'exec done');
        if (code || signal) {
            var msg = format(
                'spawn error:\n'
                + '\targv: %j\n'
                + '\texit code: %s\n'
                + '\texit signal: %s\n'
                + '\tstdout:\n%s\n'
                + '\tstderr:\n%s',
                args.argv, code, signal, stdout.trim(), stderr.trim());
            cb(new errors.InternalError({message: msg}),
               stdout, stderr);
        } else {
            cb(null, stdout, stderr);
        }
    });
}


/**
 * Call `vmadm get UUID` using CNAPI. Pretty much the same than
 * the `vmGet` function at lib/vmadm.js
 *
 * @param opts {Object}
 *      - uuid {String} The VM UUID
 *      - server {String} The UUID for the server where the VM is located
 *      - cnapi {Object CNAPI client}
 * @param cb {Function} `function (err, vm)`
 */
function vmGetRemote(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.server, 'opts.server');
    assert.object(opts.cnapi, 'opts.cnapi');
    assert.func(cb, 'cb');

    var vmLoadPath = util.format('/servers/%s/vms/%s',
        opts.server, opts.uuid);
    opts.cnapi.get({
        path: vmLoadPath
    }, function getVmCb(err, vm) {
        if (err) {
            cb(new errors.SDCClientError(err, 'cnapi'));
            return;
        }

        if (!vm) {
            cb(new errors.InternalError({
                message: 'Unexpected response from CNAPI'
            }));
            return;
        }
        cb(null, vm);
    });
}


function waitUntilTaskCompletes(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.cnapi, 'opts.cnapi');
    assert.uuid(opts.taskid, 'opts.taskid');
    assert.func(cb, 'cb');

    var counter = 0;
    var limit = 360;

    function _waitTask() {
        counter += 1;
        opts.cnapi.getTask(opts.taskid, function getTaskCb(err, task) {
            if (err) {
                cb(new errors.SDCClientError(err, 'cnapi'));
                return;
            }

            if (task.status === 'failure') {
                var msg = format('Task %s failed', opts.taskid);
                var taskErr = task.history[0].event.error;
                if (taskErr) {
                    msg += ' with error: ' +
                        taskErr.message;
                }
                cb(new errors.InternalError({ message: msg}));
            } else if (task.status === 'complete') {
                cb();
            } else if (counter < limit) {
                setTimeout(_waitTask, 5000);
            } else {
                cb(new errors.InternalError({
                    message: 'Timeout(30m) waiting for CNAPI task ' +
                        opts.taskid
                }));
            }
        });
    }
    _waitTask();
}


function vmUpdateRemote(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.server, 'opts.server');
    assert.object(opts.cnapi, 'opts.cnapi');
    assert.object(opts.params, 'opts.params');
    assert.func(cb, 'cb');

    var vmPath = util.format('/servers/%s/vms/%s/update',
        opts.server, opts.uuid);
    opts.cnapi.post({
        path: vmPath
    }, opts.params, function upVmCb(err, res) {
        if (err) {
            cb(new errors.SDCClientError(err, 'cnapi'));
            return;
        }

        if (!res || !res.id) {
            cb(new errors.InternalError({
                message: 'Unexpected response from CNAPI'
            }));
            return;
        }

        waitUntilTaskCompletes({
            cnapi: opts.cnapi,
            taskid: res.id
        }, cb);
    });
}

function getZoneIP(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.object(opts.cnapi, 'opts.cnapi');
    assert.func(cb, 'cb');

    vmGetRemote(opts, function (err, vm) {
        if (err) {
            cb(err);
            return;
        }

        var ip = netconfig.adminIpFromVmMetadata(vm);

        cb(null, ip);
    });
}

function digDomain(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.domain, 'opts.domain');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    var argv = [
        '/usr/sbin/dig',
        opts.domain,
        '+short'
    ];

    execFilePlus({
        argv: argv,
        log: opts.log
    }, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }

        var ips = stdout.trim().split('\n');
        return cb(null, ips);
    });
}


/*
 * Shared code between waitUntilZoneOutOfDNS and waitUntilZoneInDNS
 * functions below.
 */
function _waitForZoneDNSChanges(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.alias, 'opts.alias');
    assert.string(opts.domain, 'opts.domain');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.cnapi, 'opts.cnapi');
    assert.func(cb, 'cb');

    assert.bool(opts.addedToDns, 'opts.addedToDns');

    getZoneIP({
        uuid: opts.uuid,
        server: opts.server,
        cnapi: opts.cnapi
    }, function (err, ip) {
        if (err) {
            cb(err);
            return;
        }
        var counter = 0;
        var limit = 60;

        function _checkDNS() {
            digDomain({
                domain: opts.domain,
                log: opts.log
            }, function (err2, ips) {
                if (err2) {
                    cb(err2);
                    return;
                }

                if (opts.addedToDns) {
                    if (ips.indexOf(ip) !== -1) {
                        cb(null);
                        return;
                    }
                } else {
                    if (ips.indexOf(ip) === -1) {
                        cb(null);
                        return;
                    }
                }



                counter += 1;

                if (counter < limit) {
                    setTimeout(_checkDNS, 5000);
                } else {
                    var word = opts.addedToDns ? 'enter' : 'leave';
                    cb(new errors.InternalError({
                        message: format(
                            'New %s (%s) zone\'s IP %s did not %s DNS',
                            opts.alias, opts.uuid, ip, word
                        )
                    }));
                }
            });
        }

        _checkDNS();
    });
}

function waitUntilZoneInDNS(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.alias, 'opts.alias');
    assert.string(opts.domain, 'opts.domain');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.cnapi, 'opts.cnapi');
    assert.func(cb, 'cb');

    opts.addedToDns = true;

    _waitForZoneDNSChanges(opts, cb);
}

function waitUntilZoneOutOfDNS(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.alias, 'opts.alias');
    assert.string(opts.domain, 'opts.domain');
    assert.object(opts.cnapi, 'opts.cnapi');
    assert.func(cb, 'cb');

    opts.addedToDns = false;

    _waitForZoneDNSChanges(opts, cb);
}


function imgadmGetRemote(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.img_uuid, 'opts.img_uuid');
    assert.string(opts.server, 'opts.server');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    var argv = [
        '/opt/smartdc/bin/sdc-oneachnode',
        format('-n %s ', opts.server),
        '-j',
        format('/usr/sbin/imgadm get %s', opts.img_uuid)
    ];
    var env = objCopy(process.env);
    var execOpts = {
        encoding: 'utf8',
        env: env
    };
    opts.log.trace({argv: argv}, 'Getting Image info');
    execFile(argv[0], argv.slice(1), execOpts, function (err, stdout, stderr) {
        if (err) {
            var msg = format(
                'error Getting Image info %s:\n' +
                '\targv: %j\n' +
                '\texit status: %s\n' +
                '\tstdout:\n%s\n' +
                '\tstderr:\n%s', opts.img_uuid,
                argv, err.code, stdout.trim(), stderr.trim());
            cb(new errors.InternalError({
                message: msg,
                cause: err
            }));
            return;
        }
        var res = JSON.parse(stdout);
        if (!res.length || !res[0].result || !res[0].result.stdout) {
            opts.log.error({res: res}, 'imgadm get result');
            cb('Unexpected imgadm get output');
            return;
        }
        var img = JSON.parse(res[0].result.stdout);
        cb(null, img);
    });
}


/*
 * Run the manatee-adm subcommand given by "cmd" into the provided manatee VM
 *
 * @param {Object} opts: All the following options are required:
 * @param {String} opts.server: server UUID
 * @param {String} opts.vm: vm UUID
 * @param {String} opts.cmd: manatee-adm sub command
 * @param {String} opts.log: bunyan log instance
 *
 * @param {Function} cb: Callback of the form f(err, stdout, stderr);
 */
function manateeAdmRemote(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.server, 'opts.server');
    assert.string(opts.vm, 'opts.vm');
    assert.string(opts.cmd, 'opts.cmd');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    // can't handle double-quotes in `cmd`
    assert.ok(opts.cmd.indexOf('"') === -1);

    var argv = [
        '/opt/smartdc/bin/sdc-oneachnode',
        '-j',
        '-n',
        opts.server,
        format('/usr/sbin/zlogin %s "source ~/.bashrc; ' +
            '/opt/smartdc/manatee/node_modules/.bin/manatee-adm %s"',
            opts.vm, opts.cmd)
    ];

    execFilePlus({
        argv: argv,
        log: opts.log
    }, function (execErr, stdout, stderr) {
        if (execErr) {
            cb(execErr);
            return;
        }

        var err, res, resErr, out;

        if (stderr) {
            err = stderr;
        }
        try {
            res = JSON.parse(stdout);
        } catch (e) {
            resErr = e;
        }
        if (!Array.isArray(res) || !res.length || !res[0].result) {
            resErr = new errors.InternalError({
                message: 'manatee-adm state: error: unable to connect to zk'
            });
        } else {
            const output = res[0].result;
            out = output.stdout ? output.stdout.trim() : '';
            if (!err && output.stderr) {
                err = output.stderr.trim();
            }
        }
        cb(resErr, out, err);
    });
}


/*
 * Run the manatee-adm pg-status subcommand into the provided manatee VM
 * for the given shard, and return postgres and replication status
 * for the whole shard
 *
 * @param {Object} opts: All the following options are required:
 *      @param {String} opts.server: server UUID
 *      @param {String} opts.vm: vm UUID
 * @param {String} opts.log: bunyan log instance
 *
 * @param {Function} cb: Callback of the form f(err, shardStatus);
 *
 * Expected shard status has the following format for a healthy manatee shard:
 *
 * {
 *      primary: {
 *          pg_status: 'ok',
 *          repl_status: 'sync',
 *          peer_abbr: UUID_FIRST_8_CHARS
 *      },
 *      sync: {
 *          pg_status: 'ok',
 *          repl_status: 'async',
 *          peer_abbr: UUID_FIRST_8_CHARS
 *      },
 *      async: [{
 *          pg_status: 'ok'
 *          repl_status: 'async' | '-',
 *          peer_abbr: UUID_FIRST_8_CHARS
 *      }]
 * }
 *
 * Note that it's theoretically possible to have more than one async member,
 * but it isn't too common. On those cases, every async member but the last
 * one will also have a 'repl_status' member with an expected value of 'async',
 * otherwise, the 'repl_status' for the async member will be '-', which means
 * no replication.
 */
function manateeShardStatus(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.server, 'opts.server');
    assert.string(opts.vm, 'opts.vm');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    opts.cmd = 'pg-status -o role -o pg-online -o pg-repl -o peerabbr -H';
    manateeAdmRemote(opts, function (err, stdout, stderr) {
        if (err) {
            cb(err);
            return;
        }

        // We are intentionally ignoring `stderr` here. We already have all
        // the information we need from this function from `stdout` which is
        // the JSON parsed output of our cmd result.

        var shardPgSt = {};

        var pgSt = stdout.trim().split('\n');
        pgSt = pgSt.map(function (m) {
            return m.trim().split(/\s+/);
        });

        pgSt.forEach(function (m) {
            if (m[0] === 'primary' || m[0] === 'sync') {
                shardPgSt[m[0]] = {
                    pg_status: m[1],
                    repl_status: m[2],
                    peer_abbr: m[3]
                };
            } else {
                if (!shardPgSt[m[0]]) {
                    shardPgSt[m[0]] = [];
                }
                shardPgSt[m[0]].push({
                    pg_status: m[1] || '-',
                    repl_status: m[2] || '-',
                    peer_abbr: m[3]
                });
            }
        });

        cb(null, shardPgSt);
    });
}


/*
 * Run the manatee-adm freeze subcommand into the provided manatee VM
 *
 * @param {Object} opts: All the following options are required:
 * @param {String} opts.server: server UUID
 * @param {String} opts.vm: vm UUID
 * @param {String} opts.reason: the freeze message
 * @param {String} opts.log: bunyan log instance
 *
 * @param {Function} cb: Callback of the form f(err);
 */
function manateeFreeze(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.server, 'opts.server');
    assert.string(opts.vm, 'opts.vm');
    assert.string(opts.reason, 'opts.reason');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    opts.cmd = format('freeze -r \'%s\'', opts.reason);
    manateeAdmRemote(opts, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        } else if (stderr && stderr.indexOf('already been frozen') === -1) {
            return cb(new errors.InternalError({message: stderr}));
        }
        return cb();
    });
}

/*
 * Try to connect to PostgreSQL into the provided manatee VM
 *
 * @param {Object} opts: All the following options are required:
 * @param {String} opts.server: server UUID
 * @param {String} opts.vm: vm UUID
 * @param {String} opts.log: bunyan log instance
 *
 * @param {Function} cb: Callback of the form f(err);
 */
function waitForPostgresUp(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.server, 'opts.server');
    assert.string(opts.vm, 'opts.vm');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    var counter = 0;
    var limit = 36;
    function _waitForPostgresUp() {
        var argv = [
            '/opt/smartdc/bin/sdc-oneachnode',
            '-j',
            '-n',
            opts.server,
            format('/usr/sbin/zlogin %s '
                + '\'PATH=/opt/postgresql/current/bin:/opt/local/bin:$PATH '
                + 'psql -U postgres -t -A -c "SELECT NOW() AS when;"\'',
                opts.vm)
        ];

        execFilePlus({
            argv: argv,
            log: opts.log
        }, function (err, stdout, stderr) {
            if (err) {
                return cb(err);
            }
            var res = JSON.parse(stdout);
            if (!res.length || !res[0].result) {
                opts.log.error({res: res}, 'sdc-oneachnode result');
                return cb('Unexpected sdc-oneachnode result');
            }
            if (res[0].result.exit_status) {
                if (counter < limit) {
                    return setTimeout(_waitForPostgresUp, 5000);
                } else {
                    return cb('Timeout (60s) waiting for Postgres');
                }
            } else {
                return cb();
            }

        });
    }
    _waitForPostgresUp();
}

/**
 * Get a pretty duration string from a duration in milliseconds.
 *
 * From <https://github.com/joyent/node-triton>
 */
function humanDurationFromMs(ms) {
    assert.number(ms, 'ms');
    var sizes = [
        ['ms', 1000, 's'],
        ['s', 60, 'm'],
        ['m', 60, 'h'],
        ['h', 24, 'd'],
        ['d', 7, 'w']
    ];
    if (ms === 0) {
        return '0ms';
    }
    var bits = [];
    var n = ms;
    for (var i = 0; i < sizes.length; i++) {
        var size = sizes[i];
        var remainder = n % size[1];
        if (remainder === 0) {
            bits.unshift('');
        } else {
            bits.unshift(format('%d%s', remainder, size[0]));
        }
        n = Math.floor(n / size[1]);
        if (n === 0) {
            break;
        } else if (i === sizes.length - 1) {
            bits.unshift(format('%d%s', n, size[2]));
            break;
        }
    }
    if (bits.length > 1 && bits[bits.length - 1].slice(-2) === 'ms') {
        bits.pop();
    }
    return bits.slice(0, 2).join('');
}


/*
 * Call config-agent synchronously into the given server's VM, so we force an
 * immediate config rewrite.
 *
 * @param {Object} opts: All the following options are required:
 * @param {String} opts.server: server UUID
 * @param {String} opts.vm: vm UUID
 * @param {String} opts.log: bunyan log instance
 *
 * @param {Function} cb: Callback of the form f(err);
 */

function callConfigAgentSync(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.server, 'opts.server');
    assert.string(opts.vm, 'opts.vm');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    opts.log.trace({
        server: opts.server,
        zone: opts.vm
    }, 'Calling config-agent sync (sdc-oneachnode)');

    var argv = [
        '/opt/smartdc/bin/sdc-oneachnode',
        '-j',
        '-n',
        opts.server,
        format('/usr/sbin/zlogin %s ' +
            '"/opt/smartdc/config-agent/build/node/bin/node ' +
            '/opt/smartdc/config-agent/agent.js -f ' +
            '/opt/smartdc/config-agent/etc/config.json -s"', opts.vm)
    ];
    execFilePlus({
        argv: argv,
        log: opts.log
    }, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }
        var res = JSON.parse(stdout);
        if (!res.length || !res[0].result || !res[0].result.stdout) {
            opts.log.error({res: res}, 'config agent result');
            return cb(new errors.InternalError({
                message: 'Unexpected config-agent output (sdc-oneachnode)'
            }));
        }
        var out = res[0].result.stdout.trim();
        opts.log.trace(out, 'Config agent output');
        return cb(null, out);
    });
}


/*
 * Execute the provided `cmd` into the given `vm` of a `server` and return
 * stdout & stderr
 *
 * @param {Object} opts: All the following options are required:
 * @param {String} opts.server: server UUID
 * @param {String} opts.vm: vm UUID
 * @param {String} opts.cmd: the cmd to execute
 * @param {String} opts.log: bunyan log instance
 *
 * @param {Function} cb: Callback of the form f(err);
 */

function execRemote(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.server, 'opts.server');
    assert.string(opts.vm, 'opts.vm');
    assert.string(opts.cmd, 'opts.cmd');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    // can't handle double-quotes in `cmd`
    assert.ok(opts.cmd.indexOf('"') === -1);

    var argv = [
        '/opt/smartdc/bin/sdc-oneachnode',
        '-T',
        '600',
        '-j',
        '-n',
        opts.server,
        format('/usr/sbin/zlogin %s "%s"', opts.vm, opts.cmd)
    ];

    execFilePlus({
        argv: argv,
        log: opts.log
    }, function (execErr, stdout, stderr) {
        if (execErr) {
            cb(execErr);
            return;
        }
        var res, parseErr, out, err;
        try {
            // Due to the -j option of sdc-oneachnode:
            res = JSON.parse(stdout);
        } catch (e) {
            parseErr = e;
        }
        if (!Array.isArray(res) || !res.length || !res[0].result) {
            parseErr = new errors.InternalError({
                message: 'Unexpected sdc-oneachnode output'
            });
        } else {
            const output = res[0].result;
            out = output.stdout.trim() || null;
            err = output.stderr ? new errors.InternalError({
                message: output.stderr.trim()
            }) : null;
        }
        cb(parseErr, out, err);
    });
}

function execWithRetries(opts) {
    assert.object(opts, 'opts');
    assert.func(opts.func, 'opts.func');
    assert.ok(opts.args, 'opts.args');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.cb, 'opts.cb');
    assert.optionalNumber(opts.retries, 'opts.retries');
    var attempt = backoff.call(opts.func, opts.args, opts.cb);

    attempt.setStrategy(new backoff.ExponentialStrategy());
    attempt.failAfter(opts.retries || 5);
    attempt.retryIf(function (err) {
        opts.log.error({err: err}, 'Retry predicate');
        return (err && err.code && (
                err.code === 'ECONNREFUSED' ||
                err.code === 'ENOTFOUND' ||
                err.code === 'ECONNRESET' ||
                err.code === 'SDCClient'));
    });

    // Called when function is called with function's args.
    attempt.on('call', function (_args) {
    });

    // Called with results each time function returns with or w/o errors.
    attempt.on('callback', function (_err) {
    });

    // Called on backoff.
    attempt.on('backoff', function (number, delay, err) {
        var msg = util.format('Attempt #%d failed with error %s. ' +
                'Retrying again in %d msecs',
                number + 1, err, delay);
        console.log(msg);
        opts.log.debug({
            err: err
        }, msg);
    });

    attempt.start();
}


function urDiscovery(opts, cb) {
    assert.object(opts, 'opts');
    assert.optionalBool(opts.logMissingNodes, 'opts.logMissingNodes');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');
    assert.object(opts.urconn, 'opts.urconn');
    assert.arrayOfString(opts.nodes, 'opts.nodes');
    assert.func(cb, 'cb');

    var log = opts.sdcadm.log;
    var progress = opts.progress;
    var urconn = opts.urconn;

    var urAvailServers = [];
    var onceNext = once(cb);

    var disco = urconn.discover({
        timeout: 10 * SECONDS,
        exclude_headnode: false,
        node_list: opts.nodes
    });

    disco.on('server', function discoServer(urServer) {
        log.trace({urServer: urServer}, 'discoServer');
        urAvailServers.push(urServer);
    });

    disco.on('error', function discoError(err) {
        if (err.nodes_missing && err.nodes_missing.length) {
            log.debug({nodes_missing: err.nodes_missing},
                'ur disco nodes missing');
            if (opts.logMissingNodes !== false) {
                progress('Could not find %d servers (ur did not ' +
                    'respond to discovery): %s', err.nodes_missing.length,
                    err.nodes_missing.join(', '));
            }
        } else {
            progress('Unexpected ur discovery failure: %r', err);
        }
        onceNext(err);
    });

    disco.on('duplicate', function discoDup(dupUuid, dupHostname) {
        var err = new errors.InternalError({
            message: format('Duplicate server found during ur ' +
                'discovery: uuid=%s dupHostname=%s',
                dupUuid, dupHostname)
        });
        err.duplicate = [dupUuid, dupHostname];

        /*
         * We are done with this discovery session.  Cancel it and
         * ignore future error/end events.
         */
        disco.cancel();
        onceNext(err);
    });

    disco.on('end', function discoEnd() {
        log.trace('discoEnd');
        onceNext(null, urAvailServers);
    });
}


function isUsbKeyMounted(log, cb) {
    assert.object(log, 'log');
    assert.func(cb, 'cb');

    var arg = {
        key: '/mnt/usbkey/config',
        utility: '/opt/smartdc/bin/sdc-usbkey',
        utilityExists: false,
        keyIsMounted: false
    };

    function sdcUsbkeyExists(ctx, next) {
        fs.stat(ctx.utility, function (er, st) {
            if (er) {
                if (er.code === 'ENOENT') {
                    next();
                } else {
                    next(er);
                }
                return;
            }
            if (st.isFile()) {
                ctx.utilityExists = true;
            }
            next();
        });
    }

    function checkKeyMountedUsingUtility(ctx, next) {
        if (!ctx.utilityExists) {
            next();
            return;
        }

        var argv = [ctx.utility, 'status'];
        execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                next(err);
                return;
            }
            if (stderr.trim() !== '') {
                next(new Error(format('Unexpected sdc-usbkey stderr: %j',
                            stderr.trim())));
                return;
            }
            if (stdout.trim() === 'mounted') {
                ctx.keyIsMounted = true;
            }
            next();
        });
    }

    function checkMeyMounted(ctx, next) {
        if (ctx.keyIsMounted || ctx.utilityExists) {
            next();
            return;
        }
        fs.stat(ctx.key, function (er, st) {
            if (er) {
                if (er.code === 'ENOENT') {
                    next();
                } else {
                    next(er);
                }
                return;
            }
            if (st.isFile()) {
                ctx.keyIsMounted = true;
            }
            next();
        });
    }

    vasync.pipeline({funcs: [
        sdcUsbkeyExists,
        checkKeyMountedUsingUtility,
        checkMeyMounted
        ], arg: arg
    }, function (err) {
        if (err) {
            log.error({err: err}, 'common.isUsbKeyMounted');
        }
        return cb(err, arg.keyIsMounted);
    });
}

function mountUsbKey(log, cb) {
    var arg = {
        utility: '/opt/smartdc/bin/sdc-usbkey',
        script: '/usbkey/scripts/mount-usb.sh',
        utilityExists: false,
        keyIsMounted: false
    };

    function alreadyMounted(ctx, next) {
        isUsbKeyMounted(log, function (err, mounted) {
            if (err) {
                next(err);
                return;
            }
            if (mounted) {
                ctx.keyIsMounted = true;
            }
            next();
        });
    }

    function sdcUsbkeyExists(ctx, next) {
        if (ctx.keyIsMounted) {
            next();
            return;
        }
        fs.stat(ctx.utility, function (er, st) {
            if (er) {
                if (er.code === 'ENOENT') {
                    next();
                } else {
                    next(er);
                }
                return;
            }
            if (st.isFile()) {
                ctx.utilityExists = true;
            }
            next();
        });
    }

    function mountUsingUtility(ctx, next) {
        if (!ctx.utilityExists || ctx.keyIsMounted) {
            next();
            return;
        }

        var argv = [ctx.utility, 'mount'];
        execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                next(err);
                return;
            }
            if (stderr.trim() !== '') {
                next(new Error(format('Unexpected sdc-usbkey stderr: %j',
                            stderr.trim())));
                return;
            }

            if (stdout.trim() === '/mnt/usbkey') {
                ctx.keyIsMounted = true;
            }
            next();
        });

    }

    function mountUsingScript(ctx, next) {
        if (ctx.utilityExists || ctx.keyIsMounted) {
            next();
            return;
        }
        var argv = [ctx.script];
        execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                next(err);
                return;
            }
            if (stderr.trim() !== '') {
                next(new Error(
                    'Unexpected /usbkey/scripts/mount-usb.sh stderr: %s',
                    stderr.trim()));
                return;
            }
            if (stdout.trim() === '') {
                ctx.keyIsMounted = true;
            }
            next();
        });
    }

    vasync.pipeline({
        funcs: [
            alreadyMounted,
            sdcUsbkeyExists,
            mountUsingUtility,
            mountUsingScript
        ],
        arg: arg
    }, function (err) {
        if (err) {
            log.error({err: err}, 'common.mountUsbKey');
        }
        if (!arg.keyIsMounted) {
            err = new errors.InternalError({
                message: 'Unable to mount USB key'
            });
        }
        return cb(err);
    });
}

function unmountUsbKey(log, cb) {
    var arg = {
        utility: '/opt/smartdc/bin/sdc-usbkey',
        script: '/usr/sbin/umount',
        utilityExists: false,
        keyIsMounted: false
    };

    function alreadyMounted(ctx, next) {
        isUsbKeyMounted(log, function (err, mounted) {
            if (err) {
                return next(err);
            }
            if (mounted) {
                ctx.keyIsMounted = true;
            }
            return next();
        });
    }

    function sdcUsbkeyExists(ctx, next) {
        if (!ctx.keyIsMounted) {
            next();
            return;
        }
        fs.stat(ctx.utility, function (er, st) {
            if (er) {
                if (er.code === 'ENOENT') {
                    next();
                } else {
                    next(er);
                }
                return;
            }
            if (st.isFile()) {
                ctx.utilityExists = true;
            }
            next();
            return;
        });
    }

    function unmountUsingUtility(ctx, next) {
        if (!ctx.utilityExists || !ctx.keyIsMounted) {
            next();
            return;
        }

        var argv = [ctx.utility, 'unmount'];
        execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                next(err);
                return;
            }
            if (stderr.trim() !== '') {
                next(new Error('Unexpected sdc-usbkey stderr: %s',
                            stderr.trim()));
                return;
            }
            if (stdout.trim() === '') {
                ctx.keyIsMounted = false;
            }
            next();
        });

    }

    function unmountUsingScript(ctx, next) {
        if (ctx.utilityExists || !ctx.keyIsMounted) {
            next();
            return;
        }
        var argv = [ctx.script, '/mnt/usbkey'];
        execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                return next(err);
            }
            if (stderr.trim() !== '') {
                return next(new Error(
                    'Unexpected /usr/sbin/umount stderr: %s',
                    stderr.trim()));
            }
            if (stdout.trim() === '') {
                ctx.keyIsMounted = false;
            }
            return next();
        });
    }

    vasync.pipeline({
        funcs: [
            alreadyMounted,
            sdcUsbkeyExists,
            unmountUsingUtility,
            unmountUsingScript
        ],
        arg: arg
    }, function (err) {
        if (err) {
            log.error({err: err}, 'common.unmountUsbKey');
        }

        if (arg.keyIsMounted) {
            err = new errors.InternalError({
                message: 'Unable to unmount USB key'
            });
        }
        return cb(err);
    });
}

function copyFile(src, dst, cb) {
    assert.string(src, 'src');
    assert.string(dst, 'dst');
    assert.func(cb, 'cb');

    var readStream = fs.createReadStream(src);
    var writeStream = fs.createWriteStream(dst);

    function onErr(err) {
        writeStream.destroy();
        readStream.destroy();
        cb(new errors.InternalError({
            message: format('Error copying file %s to %s', src, dst),
            cause: err
        }));
    }

    readStream.once('error', onErr);
    writeStream.once('error', onErr);
    writeStream.once('finish', function () {
        cb();
    });
    readStream.pipe(writeStream);
}


// Intended to be used as second argument to JSON.stringify() in order to
// prevent 'TypeError: Converting circular structure to JSON'
function safeCycles() {
    var objs = [];
    return function (_key, value) {
        if (!value || typeof (value) !== 'object') {
            return value;
        }
        if (objs.indexOf(value) !== -1) {
            return '[Circular]';
        } else {
            objs.push(value);
        }
        return value;
    };
}

function utcTimestamp(start) {
    assert.optionalDate(start, 'start');
    if (!start) {
        start = new Date();
    }
    var stamp = sprintf('%d%02d%02dT%02d%02d%02dZ',
        start.getUTCFullYear(),
        start.getUTCMonth() + 1,
        start.getUTCDate(),
        start.getUTCHours(),
        start.getUTCMinutes(),
        start.getUTCSeconds());

    return stamp;
}

// This takes a VError instance that might be a MultiError of MultiErrors
// and will return a flattened VError (if just one) or MultiError.
function flattenMultiError(err) {
    // Dev Note: It is possible that these MultiError instances are not from the
    // same `verror` import as in this module. That means that
    // `VError.errorForEach` may not work as expected due to a `instanceof
    // MultiError` check, so we cannot use that method.
    function errsFromVError(e) {
        let errs = [];
        if (e.constructor.name === 'MultiError') {
            // `MultiError.prototype.errors()` added in verror@1.7.0.
            if (typeof (e.errors) === 'function') {
                e.errors().map(function (subErr) {
                    errs = errs.concat(errsFromVError(subErr));
                });
            } else {
                // MultiError was added to verror@1.1.0 and since the beginning
                // had a `.ase_errors` array (for its own historical reasons).
                for (let subErr of e.ase_errors) {
                    errs = errs.concat(errsFromVError(subErr));
                }
            }
        } else {
            errs.push(e);
        }
        return errs;
    }

    if (!err) {
        return null;
    }

    var flattenedErrs = errsFromVError(err);
    return VError.errorFromList(flattenedErrs);
}

function validateNetType(s) {
    return NETWORK_FUNC_MAP.hasOwnProperty(s);
}

function netTypeToNetFunc(s) {
    return NETWORK_FUNC_MAP[s].netFunc;
}

function netTypeToNicFunc(s) {
    return NETWORK_FUNC_MAP[s].nicFunc;
}

// --- exports

module.exports = {
    UUID_RE: UUID_RE,
    loadConfig: loadConfig,
    assertStrictOptions: assertStrictOptions,
    cmp: cmp,
    objCopy: objCopy,
    deepObjCopy: deepObjCopy,
    splitStr: splitStr,
    promptYesNo: promptYesNo,
    promptConfirm: promptConfirm,
    sortArrayOfObjects: sortArrayOfObjects,
    indent: indent,
    execFilePlus: execFilePlus,
    execPlus: execPlus,
    spawnRun: spawnRun,
    getZoneIP: getZoneIP,
    digDomain: digDomain,
    waitUntilZoneInDNS: waitUntilZoneInDNS,
    waitUntilZoneOutOfDNS: waitUntilZoneOutOfDNS,
    vmGetRemote: vmGetRemote,
    vmUpdateRemote: vmUpdateRemote,
    imgadmGetRemote: imgadmGetRemote,
    manateeAdmRemote: manateeAdmRemote,
    manateeFreeze: manateeFreeze,
    manateeShardStatus: manateeShardStatus,
    waitForPostgresUp: waitForPostgresUp,
    humanDurationFromMs: humanDurationFromMs,
    execRemote: execRemote,
    callConfigAgentSync: callConfigAgentSync,
    execWithRetries: execWithRetries,
    urDiscovery: urDiscovery,
    isUsbKeyMounted: isUsbKeyMounted,
    mountUsbKey: mountUsbKey,
    unmountUsbKey: unmountUsbKey,
    copyFile: copyFile,
    safeCycles: safeCycles,
    utcTimestamp: utcTimestamp,
    flattenMultiError: flattenMultiError,
    validateNetType: validateNetType,
    netTypeToNetFunc: netTypeToNetFunc,
    netTypeToNicFunc: netTypeToNicFunc
};
// vim: set softtabstop=4 shiftwidth=4:
