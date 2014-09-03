/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var p = console.log;
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var fs = require('fs');
var path = require('path');
var vasync = require('vasync');

var errors = require('../errors'),
    InternalError = errors.InternalError;
var common = require('../common');

var Procedure = require('./procedure').Procedure;

/**
 * This is a limited first pass procedure for updating a set of stateless SDC
 * services.
 *
 * Limitations:
 * - the service must only have one instance
 * - the instance must be on the headnode (where `sdcadm` is running)
 * - we only support the "stateless" easy-to-update services that don't require
 *   any migrations, bootstrapping, etc.
 */
function UpdateStatelessServicesV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateStatelessServicesV1, Procedure);

UpdateStatelessServicesV1.prototype.summarize = function ussv1Summarize() {
    return this.changes.map(function (ch) {
        return sprintf('update "%s" service to image %s (%s@%s)',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};

UpdateStatelessServicesV1.prototype.execute = function ussv1Execute(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.logCb, 'opts.logCb');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = opts.sdcadm;
    var log = opts.log;
    var logCb = opts.logCb;

    // For now we'll update services in series.
    // TODO: Should eventually be able to do this in parallel, or batches.
    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateSvc
    }, cb);

    var userScript;
    function updateSvc(change, nextSvc) {
        var inst = change.inst;
        var svc = change.service;
        var img = change.image;
        vasync.pipeline({funcs: [
            /**
             * Get past HEAD-1804 where we changed to a common user-script
             * (that shall not change again).
             *
             * Note: sdcadm's "etc/setup/user-script" is a copy of
             * "usb-headnode.git:defaults/user-script.common". At the time of
             * writing the latter is canonical. Eventually, when we have
             * "sdcadm setup", the former will be canonical.
             */
            function getUserScript(_, next) {
                if (userScript) {
                    return next();
                }
                var userScriptPath = path.resolve(__dirname, '..', '..',
                        'etc', 'setup', 'user-script');
                fs.readFile(userScriptPath, 'utf8', function (err, content) {
                    userScript = content;
                    next(err);
                });
            },
            function writeOldUserScriptForRollback(_, next) {
                if (svc.metadata['user-script'] === userScript) {
                    return next();
                }
                var usPath = path.resolve(opts.wrkDir,
                    format('%s.%s.user-script', svc.uuid, img.uuid));
                log.debug({usPath: usPath, service: svc.name},
                    'save old user-script for possible rollback');
                fs.writeFile(usPath,
                    svc.metadata['user-script'],
                    'utf8',
                    function (err) {
                        if (err) {
                            return next(new errors.UpdateError(err,
                                'error saving old user-script: ' + usPath));
                        }
                        next();
                    });
            },
            function updateSvcUserScript(_, next) {
                if (svc.metadata['user-script'] === userScript) {
                    return next();
                }
                logCb(format('Update "%s" service user-script', svc.name));
                sdcadm.sapi.updateService(
                    change.service.uuid,
                    {
                        params: {
                            'user-script': userScript
                        }
                    },
                    errors.sdcClientErrWrap(next, 'sapi'));
            },
            function updateVmUserScript(_, next) {
                if (svc.metadata['user-script'] === userScript) {
                    return next();
                }
                logCb(format('Update "%s" VM %s user-script', svc.name,
                    inst.zonename));
                log.trace({inst: inst, image: change.image.uuid},
                    'reprovision VM inst');
                var child = spawn('/usr/sbin/vmadm', ['update', inst.zonename]);
                var stdout = [];
                var stderr = [];
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', function (s) { stdout.push(s); });
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', function (s) { stderr.push(s); });
                child.on('close', function vmadmDone(code, signal) {
                    stdout = stdout.join('');
                    stderr = stderr.join('');
                    log.debug({inst: inst, image: change.image.uuid,
                        code: code, signal: signal,
                        stdout: stdout, stderr: stderr},
                        'reprovisioned VM inst');
                    if (code || signal) {
                        var msg = format(
                            'error update VM %s user-script: '
                            + 'exit code %s, signal %s\n'
                            + '    stdout:\n%s'
                            + '    stderr:\n%s',
                            inst.zonename, code, signal,
                            common.indent(stdout, '        '),
                            common.indent(stderr, '        '));
                        return next(new errors.InternalError({message: msg}));
                    }
                    next();
                });
                child.stdin.setEncoding('utf8');
                child.stdin.write(JSON.stringify({
                    customer_metadata: {
                        'user-script': userScript
                    }
                }));
                child.stdin.end();
            },

            function updateSapiSvc(_, next) {
                sdcadm.sapi.updateService(
                    change.service.uuid,
                    {
                        params: {
                            image_uuid: change.image.uuid
                        }
                    },
                    errors.sdcClientErrWrap(next, 'sapi'));
            },

            function imgadmInstall(_, next) {
                logCb(format('Installing image %s (%s@%s)', img.uuid,
                    img.name, img.version));

                var argv = ['/usr/sbin/imgadm', 'import', '-q', img.uuid];

                var env = common.objCopy(process.env);
                // Get 'debug' level logging in imgadm >=2.6.0 without
                // triggering trace level logging in imgadm versions before
                // that. Trace level logging is too much here.
                env.IMGADM_LOG_LEVEL = 'debug';
                var execOpts = {
                    encoding: 'utf8',
                    env: env
                };
                log.trace({argv: argv}, 'installing VM image');
                execFile(argv[0], argv.slice(1), execOpts,
                    function (err, stdout, stderr) {
                        if (err) {
                            var msg = format(
                                'error importing VM image %s:\n'
                                + '\targv: %j\n'
                                + '\texit status: %s\n'
                                + '\tstdout:\n%s\n'
                                + '\tstderr:\n%s', img.uuid,
                                argv, err.code, stdout.trim(), stderr.trim());
                            return next(new errors.InternalError({
                                message: msg,
                                cause: err
                            }));
                        }
                        next();
                    });
            },

            /**
             *  echo '{}' | json -e "this.image_uuid = '${image_uuid}'" |
             *      vmadm reprovision ${instance_uuid}
             */
            function reprovision(_, next) {
                // TODO(trent): refactor this into ./lib/vmadm.js
                logCb(format('Reprovisioning %s VM %s', inst.service,
                    inst.zonename));
                log.trace({inst: inst, image: change.image.uuid},
                    'reprovision VM inst');
                var child = spawn('/usr/sbin/vmadm',
                    ['reprovision', inst.zonename]);
                var stdout = [];
                var stderr = [];
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', function (s) { stdout.push(s); });
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', function (s) { stderr.push(s); });
                child.on('close', function vmadmDone(code, signal) {
                    stdout = stdout.join('');
                    stderr = stderr.join('');
                    log.debug({inst: inst, image: change.image.uuid,
                        code: code, signal: signal, stdout: stdout,
                        stderr: stderr},
                        'reprovisioned VM inst');
                    if (code || signal) {
                        var msg = format(
                            'error reprovisioning VM %s: '
                            + 'exit code %s, signal %s\n'
                            + '    stdout:\n%s'
                            + '    stderr:\n%s',
                            inst.zonename, code, signal,
                            common.indent(stdout, '        '),
                            common.indent(stderr, '        '));
                        return next(new errors.InternalError({message: msg}));
                    }
                    next();
                });
                child.stdin.setEncoding('utf8');
                child.stdin.write(JSON.stringify({
                    image_uuid: change.image.uuid
                }));
                child.stdin.end();
            },

            function waitForInstToBeUp(_, next) {
                // For now we are using the lame 60s sleep from incr-upgrade's
                // upgrade-all.sh.
                // TODO: improve this to use instance "up" checks from TOOLS-551
                logCb(format('Wait (60s) for %s instance %s to come up',
                    inst.service, inst.zonename));
                setTimeout(next, 60 * 1000);
            }
        ]}, nextSvc);
    }
};

//---- exports

module.exports = {
    UpdateStatelessServicesV1: UpdateStatelessServicesV1
};
// vim: set softtabstop=4 shiftwidth=4:
