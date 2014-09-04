/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */
var path = require('path');
var fs = require('fs');
var util = require('util'),
    format = util.format;
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;

var common = require('../common');
var errors = require('../errors'),
    InternalError = errors.InternalError;

/**
 * Get past HEAD-1804 where we changed to a common user-script
 * (that shall not change again).
 *
 * Note: sdcadm's "etc/setup/user-script" is a copy of
 * "usb-headnode.git:defaults/user-script.common". At the time of
 * writing the latter is canonical. Eventually, when we have
 * "sdcadm setup", the former will be canonical.
 */
function getUserScript(arg, next) {
    if (arg.userScript) {
        return next();
    }
    var userScriptPath = path.resolve(__dirname, '..', '..',
            'etc', 'setup', 'user-script');
    fs.readFile(userScriptPath, 'utf8', function (err, content) {
        arg.userScript = content;
        next(err);
    });
}

function writeOldUserScriptForRollback(arg, next) {
    var svc = arg.change.service;
    var img = arg.change.image;
    var log = arg.opts.log;
    if (svc.metadata['user-script'] === arg.userScript) {
        return next();
    }
    var usPath = path.resolve(arg.opts.wrkDir,
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
}

function updateSvcUserScript(arg, next) {
    var svc = arg.change.service;
    var logCb = arg.opts.logCb;
    var sdcadm = arg.opts.sdcadm;
    if (svc.metadata['user-script'] === arg.userScript) {
        return next();
    }
    logCb(format('Update "%s" service user-script', svc.name));
    sdcadm.sapi.updateService(
        arg.change.service.uuid,
        {
            params: {
                'user-script': arg.userScript
            }
        },
        errors.sdcClientErrWrap(next, 'sapi'));
}

function updateVmUserScript(arg, next) {
    var svc = arg.change.service;
    var logCb = arg.opts.logCb;
    var inst = arg.change.inst;
    var log = arg.opts.log;
    if (svc.metadata['user-script'] === arg.userScript) {
        return next();
    }
    logCb(format('Update "%s" VM %s user-script', svc.name,
        inst.zonename));
    log.trace({inst: inst, image: arg.change.image.uuid},
        'reprovision VM inst');
    var child = spawn('/usr/sbin/vmadm', ['update', inst.zonename]);
    var stdout = [];
    var stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (s) {
        stdout.push(s);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (s) {
        stderr.push(s);
    });
    child.on('close', function vmadmDone(code, signal) {
        stdout = stdout.join('');
        stderr = stderr.join('');
        log.debug({inst: inst, image: arg.change.image.uuid,
            code: code, signal: signal,
            stdout: stdout, stderr: stderr},
            'reprovisioned VM inst');
        if (code || signal) {
            var msg = format(
                'error update VM %s user-script: ' +
                'exit code %s, signal %s\n' +
                '    stdout:\n%s' +
                '    stderr:\n%s',
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
            'user-script': arg.userScript
        }
    }));
    child.stdin.end();
}

function updateSapiSvc(arg, next) {
    var sdcadm = arg.opts.sdcadm;
    sdcadm.sapi.updateService(
        arg.change.service.uuid,
        {
            params: {
                image_uuid: arg.change.image.uuid
            }
        },
        errors.sdcClientErrWrap(next, 'sapi'));
}

function imgadmInstall(arg, next) {
    var logCb = arg.opts.logCb;
    var img = arg.change.image;
    var log = arg.opts.log;
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
                    'error importing VM image %s:\n' +
                    '\targv: %j\n' +
                    '\texit status: %s\n' +
                    '\tstdout:\n%s\n' +
                    '\tstderr:\n%s', img.uuid,
                    argv, err.code, stdout.trim(), stderr.trim());
                return next(new errors.InternalError({
                    message: msg,
                    cause: err
                }));
            }
            next();
        });
}

/**
 *  echo '{}' | json -e "this.image_uuid = '${image_uuid}'" |
 *      vmadm reprovision ${instance_uuid}
 */
function reprovision(arg, next) {
    var logCb = arg.opts.logCb;
    var inst = arg.change.inst;
    var log = arg.opts.log;
    // TODO(trent): refactor this into ./lib/vmadm.js
    logCb(format('Reprovisioning %s VM %s', inst.service,
        inst.zonename));
    log.trace({inst: inst, image: arg.change.image.uuid},
        'reprovision VM inst');
    var child = spawn('/usr/sbin/vmadm',
        ['reprovision', inst.zonename]);
    var stdout = [];
    var stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (s) {
        stdout.push(s);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (s) {
        stderr.push(s);
    });
    child.on('close', function vmadmDone(code, signal) {
        stdout = stdout.join('');
        stderr = stderr.join('');
        log.debug({inst: inst, image: arg.change.image.uuid,
            code: code, signal: signal, stdout: stdout,
            stderr: stderr},
            'reprovisioned VM inst');
        if (code || signal) {
            var msg = format(
                'error reprovisioning VM %s: ' +
                'exit code %s, signal %s\n' +
                '    stdout:\n%s' +
                '    stderr:\n%s',
                inst.zonename, code, signal,
                common.indent(stdout, '        '),
                common.indent(stderr, '        '));
            return next(new errors.InternalError({message: msg}));
        }
        next();
    });
    child.stdin.setEncoding('utf8');
    child.stdin.write(JSON.stringify({
        image_uuid: arg.change.image.uuid
    }));
    child.stdin.end();
}

function waitForInstToBeUp(arg, next) {
    var logCb = arg.opts.logCb;
    var inst = arg.change.inst;
    // For now we are using the lame 60s sleep from incr-upgrade's
    // upgrade-all.sh.
    // TODO: improve this to use instance "up" checks from TOOLS-551
    logCb(format('Wait (60s) for %s instance %s to come up',
        inst.service, inst.zonename));
    setTimeout(next, 60 * 1000);
}

//---- exports

module.exports = {
    getUserScript: getUserScript,
    writeOldUserScriptForRollback: writeOldUserScriptForRollback,
    updateSvcUserScript: updateSvcUserScript,
    updateVmUserScript: updateVmUserScript,
    updateSapiSvc: updateSapiSvc,
    imgadmInstall: imgadmInstall,
    reprovision: reprovision,
    waitForInstToBeUp: waitForInstToBeUp
};
// vim: set softtabstop=4 shiftwidth=4:
