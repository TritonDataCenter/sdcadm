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
var vasync = require('vasync');
var vmadm = require('../vmadm');
var svcadm = require('../svcadm');
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


/**
 * In case of rollback, we need to get the old user script from the previously
 * made backup and proceed exactly the same way.
 */
function getOldUserScript(arg, next) {
    if (arg.userScript) {
        return next();
    }
    var svc = arg.change.service;
    var img = arg.change.inst.image;
    var log = arg.opts.log;

    var usPath = path.resolve(arg.opts.upDir,
        format('%s.%s.user-script', svc.uuid, img));

    log.debug({usPath: usPath, service: svc.name},
        'looking for old user-script for possible rollback');

    fs.exists(usPath, function (exists) {
        if (!exists) {
            arg.userScript = svc.metadata['user-script'];
            return next();
        }

        fs.readFile(usPath, 'utf8', function (err, content) {
            arg.userScript = content;
            next(err);
        });
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
    var progress = arg.opts.progress;
    var sdcadm = arg.opts.sdcadm;
    if (svc.metadata['user-script'] === arg.userScript) {
        return next();
    }
    progress('Update "%s" service user-script', svc.name);
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
    var progress = arg.opts.progress;
    var inst = arg.change.inst;
    var log = arg.opts.log;
    if (svc.metadata && svc.metadata['user-script'] === arg.userScript) {
        return next();
    }
    progress('Update "%s" VM %s user-script', svc.name, inst.zonename);
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
            'updated VM inst');
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
        set_customer_metadata: {
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
    var progress = arg.opts.progress;
    var img = arg.change.image;
    var log = arg.opts.log;
    progress('Installing image %s (%s@%s)', img.uuid, img.name, img.version);

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
    var progress = arg.opts.progress;
    var inst = arg.change.inst;
    var log = arg.opts.log;
    // TODO(trent): refactor this into ./lib/vmadm.js
    progress('Reprovisioning %s VM %s', inst.service, inst.zonename);
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
    var progress = arg.opts.progress;
    var inst = arg.change.inst;
    // For now we are using the lame 60s sleep from incr-upgrade's
    // upgrade-all.sh.
    // TODO: improve this to use instance "up" checks from TOOLS-551
    progress('Wait (60s) for %s instance %s to come up',
        inst.service, inst.zonename);
    setTimeout(next, 60 * 1000);
}


// --- Used by upgrades going through temp instances:

function checkHA(arg, next) {
    var progress = arg.opts.progress;
    var sdcadm = arg.opts.sdcadm;
    var svc = arg.change.service;

    progress('Verifying if we are on an HA setup');
    sdcadm.sapi.listInstances({
        service_uuid: svc.uuid
    }, function (err, instances) {
        if (err) {
            next(err);
        } else {
            if (instances.length > 1) {
                arg.HA = true;
            }
            next();
        }
    });
}


function provisionTmpVm(arg, next) {
    if (arg.HA) {
        return next();
    }
    var progress = arg.opts.progress;
    var sdcadm = arg.opts.sdcadm;
    var inst = arg.change.inst;
    var log = arg.opts.log;
    var svc = arg.change.service;

    progress('Provisioning Temporary %s VM %s', inst.service,
        arg.tmpAlias);
    log.trace({alias: arg.tmpAlias, image: arg.change.image.uuid},
        'Provisioning temporary VM inst');
    sdcadm.sapi.createInstance(svc.uuid, {
        params: {
            owner_uuid: sdcadm.config.ufds_admin_uuid,
            alias: arg.tmpAlias
        }
    }, function (err, body) {
        if (err) {
            return next(err);
        }
        arg.tmpUUID = body.uuid;
        return next();
    });
}


function waitForTmpInstToBeUp(arg, next) {
    if (arg.HA) {
        return next();
    }
    var progress = arg.opts.progress;
    var inst = arg.change.inst;
    // For now we are using the lame sleep from incr-upgrade's
    // upgrade-all.sh.
    // TODO: improve this to use instance "up" checks from TOOLS-551
    progress('Wait (sleep) for %s instance %s to come up',
        inst.service, arg.tmpUUID);
    setTimeout(next, 15 * 1000);
}


function getTmpInstanceUUID(arg, next) {
    if (arg.HA) {
        return next();
    }
    var progress = arg.opts.progress;
    var log = arg.opts.log;
    progress('Running vmadm lookup to get tmp instance UUID');
    var argv = [
        '/usr/sbin/vmadm',
        'lookup',
        '-1',
        'alias=' + arg.tmpAlias
    ];
    common.execFilePlus({
        argv: argv,
        log: log
    }, function (err, stdout, stderr) {
        if (err) {
            next(err);
        } else {
            arg.tmpUUID = stdout.trim();
            log.debug('Tmp instance found: %s', arg.tmpUUID);
            next();
        }
    });
}

function checkIfTmpVMHasErrors(arg, next) {
    if (arg.HA) {
        return next();
    }
    var progress = arg.opts.progress;
    var log = arg.opts.log;
    progress('Checking if tmp instace %s services have errors', arg.tmpUUID);
    var argv = ['/usr/bin/svcs', '-z', arg.tmpUUID, '-x'];
    common.execFilePlus({
        argv: argv,
        log: log
    }, function (err, stdout, stderr) {
        if (err) {
            return next(err);
        }
        var errs = stdout.trim();
        if (errs) {
            return next(errs);
        }
        return next();
    });
}

function disableVMRegistrar(arg, next) {
    var progress = arg.progress;
    var zonename = arg.zonename;
    var log = arg.log;
    progress('Disabling registrar on VM %s', zonename);
    svcadm.svcadmDisable({
        fmri: 'registrar',
        zone: zonename,
        wait: true,
        log: log
    }, next);
}

function waitUntilVMNotInDNS(arg, next) {
    var progress = arg.progress;
    var zonename = arg.zonename;
    progress('Wait until VM %s is out of DNS', zonename);
    common.waitUntilZoneOutOfDNS({
        uuid: zonename,
        alias: arg.alias,
        domain: arg.domain,
        log: arg.log
    }, next);
}

function waitUntilVmInDNS(arg, next) {
    var progress = arg.progress;
    var zonename = arg.zonename;
    progress('Waiting until %s instance is in DNS', zonename);
    common.waitUntilZoneInDNS({
        uuid: zonename,
        alias: arg.alias,
        domain: arg.domain,
        log: arg.log
    }, next);
}

function stopTmpVm(arg, next) {
    if (arg.HA) {
        return next();
    }
    var progress = arg.opts.progress;
    var log = arg.opts.log;
    progress('Stop tmp VM %s', arg.tmpUUID);
    vmadm.vmStop(arg.tmpUUID, {
        log: log
    }, next);
}

function destroyTmpVM(arg, next) {
    if (arg.HA) {
        return next();
    }
    var progress = arg.opts.progress;
    var sdcadm = arg.opts.sdcadm;
    progress('Destroying tmp VM %s (%s)', arg.tmpUUID, arg.tmpAlias);
    sdcadm.sapi.deleteInstance(arg.tmpUUID, next);
}

function createInstance(arg, next) {
    var progress = arg.opts.progress;
    var sdcadm = arg.opts.sdcadm;

    progress('Creating "%s" instance', arg.alias);
    var iOpts = {
        params: {
            alias: arg.alias,
            owner_uuid: sdcadm.config.ufds_admin_uuid,
            server_uuid: arg.change.server
        },
        metadata: {}
    };

    var svc = arg.change.service.uuid;
    sdcadm.sapi.createInstance(svc, iOpts, function (err, inst_) {
        if (err) {
            return next(
                new errors.SDCClientError(err, 'sapi'));
        }
        progress('Instance "%s" (%s) created',
            inst_.uuid, inst_.params.alias);

        arg.change.inst = {
            alias: arg.alias,
            service: arg.change.service.name,
            zonename: inst_.uuid,
            uuid: inst_.uuid
        };
        return next();
    });
}

// Functions operating remotely through sdc-oneachnode:

// Same than imgadmInstall but through sdc-oneachnode
function imgadmInstallRemote(opts, callback) {
    var server = opts.server;
    var img = opts.img;
    var progress = opts.progress;
    var log = opts.log;

    progress('Installing image %s (%s@%s)', img.uuid, img.name, img.version);

    var argv = [
        '/opt/smartdc/bin/sdc-oneachnode',
        format('-n %s ', server),
        format('/usr/sbin/imgadm import -q %s', img.uuid)
    ];

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
    execFile(argv[0], argv.slice(1), execOpts, function (err, stdout, stderr) {
        if (err) {
            var msg = format(
                'error importing VM image %s:\n' +
                '\targv: %j\n' +
                '\texit status: %s\n' +
                '\tstdout:\n%s\n' +
                '\tstderr:\n%s', img.uuid,
                argv, err.code, stdout.trim(), stderr.trim());
            return callback(new errors.InternalError({
                message: msg,
                cause: err
            }));
        }
        callback();
    });
}

// Disable registrar using sdc-oneachnode
function disableVMRegistrarRemote(arg, callback) {
    var progress = arg.progress;
    var zonename = arg.zonename;
    var log = arg.log;
    var server = arg.server;

    progress('Disabling registrar on VM %s (Server: %s)', zonename, server);

    var argv = [
        '/opt/smartdc/bin/sdc-oneachnode',
        format('-n %s ', server),
        format('/usr/sbin/svcadm -z %s disable registrar', zonename)
    ];

    var env = common.objCopy(process.env);
    log.trace({argv: argv}, 'Disabling VM registrar');
    var execOpts = {
        encoding: 'utf8',
        env: env
    };

    execFile(argv[0], argv.slice(1), execOpts, function (err, stdout, stderr) {
        if (err) {
            var msg = format(
                'error disabling VM registrar %s:\n' +
                '\targv: %j\n' +
                '\texit status: %s\n' +
                '\tstdout:\n%s\n' +
                '\tstderr:\n%s', zonename,
                argv, err.code, stdout.trim(), stderr.trim());
            return callback(new errors.InternalError({
                message: msg,
                cause: err
            }));
        }
        callback();
    });
}

// Reprovision through sdc-oneachnode
function reprovisionRemote(opts, callback) {
    var server = opts.server;
    var zonename = opts.zonename;
    var img = opts.img;
    var progress = opts.progress;
    var log = opts.log;

    progress('Reprovisioning %s VM %s', zonename, server);
    log.trace({inst: zonename, image: img.uuid, server: server},
        'reprovision VM inst');
    var child = spawn('/opt/smartdc/bin/sdc-oneachnode', [
        format('-n %s ', server),
        format('echo \'{}\' | /usr/bin/json -e "this.image_uuid=\'%s\'" ' +
            '| /usr/sbin/vmadm reprovision %s', img.uuid, zonename)
    ]);
    var stdout = [];
    var stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (so) {
        stdout.push(so);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (se) {
        stderr.push(se);
    });
    child.on('close', function vmadmDone(code, signal) {
        stdout = stdout.join('');
        stderr = stderr.join('');
        log.debug({inst: zonename, image: img.uuid, server: server,
            code: code, signal: signal, stdout: stdout,
            stderr: stderr},
            'reprovisioned VM inst');
        if (code || signal) {
            var msg = format(
                'error reprovisioning VM %s: ' +
                'exit code %s, signal %s\n' +
                '    stdout:\n%s' +
                '    stderr:\n%s',
                zonename, code, signal,
                common.indent(stdout, '        '),
                common.indent(stderr, '        '));
            return callback(new errors.InternalError({message: msg}));
        }
        callback();
    });
}

// Same than updateVmUserScript, but using sdc-oneachnode
function updateVmUserScriptRemote(arg, next) {
    var svc = arg.service;
    var progress = arg.progress;
    var zonename = arg.zonename;
    var log = arg.log;
    var server = arg.server;
    if (svc.metadata['user-script'] === arg.userScript) {
        return next();
    }
    progress('Update "%s" VM %s user-script', svc.name, zonename);
    log.trace({inst: zonename, userScript: arg.userScript},
        'Update User Script');
    var child = spawn('/opt/smartdc/bin/sdc-oneachnode', [
        format('-n %s ', server),
        'echo \'' +  JSON.stringify({
            set_customer_metadata: {
                /* JSSTYLED */
                'user-script': arg.userScript.replace(/'/g, '"')
            }
        })  + '\'|' +
        format('/usr/sbin/vmadm update %s ', zonename)
    ]);
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
        log.debug({inst: zonename, userScript: arg.userScript,
            code: code, signal: signal,
            stdout: stdout, stderr: stderr},
            'Updated user script');
        if (code || signal) {
            var msg = format(
                'error update VM %s user-script: ' +
                'exit code %s, signal %s\n' +
                '    stdout:\n%s' +
                '    stderr:\n%s',
                zonename, code, signal,
                common.indent(stdout, '        '),
                common.indent(stderr, '        '));
            return next(new errors.InternalError({message: msg}));
        }
        next();
    });
}

function ensureDelegateDataset(arg, next) {
    var inst = arg.change.inst;
    var log = arg.opts.log;
    var progress = arg.opts.progress;
    var expectedDs = format('zones/%s/data', inst.zonename);

    function addDelegateDataset() {
        vasync.pipeline({funcs: [
            createDataset,
            setZonedOn,
            zonecfgAddDataset
        ], arg: arg}, next);
    }

    function createDataset(_, nextCb) {
        var argv = [
            '/usr/sbin/zfs',
            'create',
            expectedDs
        ];
        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                nextCb(err);
            } else {
                log.debug('zfs dataset created: %s', stdout.toString());
                nextCb();
            }
        });
    }

    function setZonedOn(_, nextCb) {
        var argv = [
            '/usr/sbin/zfs',
            'set', 'zoned=on',
            expectedDs
        ];
        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                nextCb(err);
            } else {
                log.debug('zfs dataset set zoned=on: %s', stdout.toString());
                nextCb();
            }
        });
    }

    function zonecfgAddDataset(_, nextCb) {
        var argv = [
            '/usr/sbin/zonecfg',
            '-z', inst.zonename,
            'add dataset; set name=' + expectedDs + '; end'
        ];
        common.execFilePlus({
            argv: argv,
            log: log
        }, function (err, stdout, stderr) {
            if (err) {
                nextCb(err);
            } else {
                log.debug('zonecfg set dataset name: %s', stdout.toString());
                nextCb();
            }
        });
    }

    vmadm.vmGet(inst.zonename, {log: log}, function (err, vm) {
        if (err) {
            return next(err);
        }
        if (!vm.datasets || vm.datasets.indexOf(expectedDs) === -1) {
            progress('Adding a delegate dataset to "%s" VM %s', inst.service,
                inst.zonename);
            return addDelegateDataset();
        }

        progress('"%s" VM already has a delegate dataset', inst.service);
        next();
    });
}


// TODO(pedro): This is a dupe from procedures/update-manatee-v2.js
/**
 * Get Manatee Shard status using manatee-adm into the given manatee VM, which
 * may be on any server, not only the one running sdcadm command.
 *
 * @param {Object} opts: should include:
 *      - manateeUUID {String}: UUID of the manatee VM where we want to execute
 *          manatee-adm in order to check the current shard status
 *      - server {String}: UUID of the server containing the aformentioned
 *          manatee VM
 *      - leaderIP {String}: IP of the ZK leader to be used instead of ENV vars
 *      - log {Bunyan Logger}.
 * @param {Function} callback: of the form f(err, shard).
 */
function getShardStatus(opts, callback) {
    var cmd = '/opt/smartdc/manatee/node_modules/.bin/manatee-adm status';
    if (opts.leaderIP) {
        cmd += ' -z ' + opts.leaderIP + ':2181';
    }
    var argv = [
        '/opt/smartdc/bin/sdc-oneachnode',
        '-j',
        format('-n %s ', opts.server),
        format('/usr/sbin/zlogin %s ', opts.manateeUUID) +
        '\'source ~/.bashrc; ' + cmd + '\''
    ];

    common.execFilePlus({
        argv: argv,
        log: opts.log
    }, function (err, stdout, stderr) {
        if (err) {
            return callback(err);
        }
        var res = JSON.parse(stdout);
        if (!res.length || !res[0].result || !res[0].result.stdout) {
            opts.log.error({res: res}, 'manatee-adm result');
            return callback('Unexpected manatee-adm output');
        }
        var manateeShard = JSON.parse(res[0].result.stdout.trim());
        return callback(null, manateeShard);
    });
}

// TODO(pedro): This is +/- a dupe from procedures/update-manatee-v2.js
/**
 * Wait for manatee given state
 *
 * @param {Object} opts: should include:
 *      - manateeUUID {String}: UUID of the manatee VM where we want to execute
 *          manatee-adm in order to check the current shard status
 *      - server {String}: UUID of the server containing the aformentioned
 *          manatee VM
 *      - log {Bunyan Logger}.
 *      - leaderIP {String}: IP of the ZK leader to be used instead of ENV vars
 *      - state {String}: The desired manatee state. One of 'transition',
 *          'down', 'empty', 'async', 'sync' or 'primary'.
 * @param {Function} callback: of the form f(err).
 */
function waitForManatee(opts, callback) {
    var counter = 0;
    var limit = 180;
    function _waitForStatus() {
        getShardStatus(opts, function (err, obj) {
            counter += 1;

            if (err) {
                return callback(err);
            }

            var mode = 'transition';
            var up;
            if (!obj.sdc) {
                mode = 'transition';
            } else if (Object.keys(obj.sdc).length === 0) {
                mode = 'empty';
            } else if (obj.sdc.primary && obj.sdc.sync && obj.sdc.async) {
                up = obj.sdc.async.repl && !obj.sdc.async.repl.length &&
                    Object.keys(obj.sdc.async.repl).length === 0;
                if (up && obj.sdc.sync.repl &&
                    obj.sdc.sync.repl.sync_state === 'async') {
                    mode = 'async';
                }
            } else if (obj.sdc.primary && obj.sdc.sync) {
                up = obj.sdc.sync.repl && !obj.sdc.sync.repl.length &&
                    Object.keys(obj.sdc.sync.repl).length === 0;
                if (up && obj.sdc.primary.repl &&
                        obj.sdc.primary.repl.sync_state === 'sync') {
                    mode = 'sync';
                }
            } else if (obj.sdc.primary) {
                up = obj.sdc.primary.repl && !obj.sdc.primary.repl.length &&
                    Object.keys(obj.sdc.primary.repl).length === 0;
                if (up) {
                    mode = 'primary';
                } else {
                    mode = 'down';
                }
            }

            if (mode === opts.state) {
                return callback(null);
            }

            if (counter < limit) {
                return setTimeout(_waitForStatus, 5000);
            } else {
                return callback(format(
                    'Timeout (15m) waiting for manatee to reach %s',
                    opts.state));
            }

        });
    }
    _waitForStatus();
}


// Not exported:
function _svcadmRemoteService(opts, callback) {
    opts.log.trace({
        server: opts.server,
        zone: opts.zone,
        fmri: opts.fmri
    }, format('%s remote service (sdc-oneachnode)', opts.cmd));
    var argv = [
        '/opt/smartdc/bin/sdc-oneachnode',
        format('-n %s ', opts.server)
    ];
    // Only svcadm enable/disable take the '-s' option:
    if (opts.cmd !== 'enable' && opts.cmd !== 'disable') {
        argv.push(format('svcadm -z %s %s %s; ',
                    opts.zone, opts.cmd, opts.fmri));
    } else {
        argv.push(format('svcadm -z %s %s -s %s; ',
                    opts.zone, opts.cmd, opts.fmri));
    }
    common.execFilePlus({
        argv: argv,
        log: opts.log
    }, function (err, stdout, stderr) {
        if (err) {
            callback(err);
        } else {
            callback();
        }
    });
}

function restartRemoteSvc(opts, callback) {
    opts.cmd = 'restart';
    _svcadmRemoteService(opts, callback);
}

function disableRemoteSvc(opts, callback) {
    opts.cmd = 'disable';
    _svcadmRemoteService(opts, callback);
}

function enableRemoteSvc(opts, callback) {
    opts.cmd = 'enable';
    _svcadmRemoteService(opts, callback);
}

// Disable manatee-sitter service across all the manatees on the SDC cluster
function disableManateeSitter(opts, cb) {
    var shard = opts.shard;
    var log = opts.log;
    var progress = opts.progress;
    var leaderIP = opts.leaderIP || null;

    vasync.pipeline({funcs: [
        function disableAsyncManatee(_, next) {
            if (!shard.sdc.async) {
                return next();
            }
            progress('Disabling async manatee');
            disableRemoteSvc({
                server: shard.sdc.async.server,
                zone: shard.sdc.async.zoneId,
                fmri: 'manatee-sitter',
                log: log
            }, next);
        },

        function waitAsyncDisabled(_, next) {
            if (!shard.sdc.async) {
                return next();
            }
            progress('Waiting for async manatee to be disabled');
            waitForManatee({
                state: 'sync',
                server: shard.sdc.primary.server,
                manateeUUID: shard.sdc.primary.zoneId,
                log: log,
                leaderIP: leaderIP
            }, next);
        },

        function disableSyncManatee(_, next) {
            if (!shard.sdc.sync) {
                return next();
            }
            progress('Disabling sync manatee');
            disableRemoteSvc({
                server: shard.sdc.sync.server,
                zone: shard.sdc.sync.zoneId,
                fmri: 'manatee-sitter',
                log: log
            }, next);
        },

        function waitSyncDisabled(_, next) {
            if (!shard.sdc.sync) {
                return next();
            }
            progress('Waiting for sync manatee to be disabled');
            waitForManatee({
                state: 'primary',
                server: shard.sdc.primary.server,
                manateeUUID: shard.sdc.primary.zoneId,
                log: log,
                leaderIP: leaderIP
            }, next);
        },

        function disablePrimaryManatee(_, next) {
            progress('Disabling primary manatee');
            disableRemoteSvc({
                server: shard.sdc.primary.server,
                zone: shard.sdc.primary.zoneId,
                fmri: 'manatee-sitter',
                log: log
            }, next);
        },

        function waitPrimaryDisabled(_, next) {
            progress('Waiting for primary manatee to be disabled');
            waitForManatee({
                state: 'down',
                server: shard.sdc.primary.server,
                manateeUUID: shard.sdc.primary.zoneId,
                log: log,
                leaderIP: leaderIP
            }, next);
        }
    ]}, cb);

}


// Enable manatee-sitter service across all the manatees on the SDC cluster.
// (See disableManateeSitter)
function enableManateeSitter(opts, cb) {
    var shard = opts.shard;
    var log = opts.log;
    var progress = opts.progress;
    var leaderIP = opts.leaderIP || null;

    vasync.pipeline({funcs: [
        function enablePrimaryManatee(_, next) {
            progress('Enabling primary manatee');
            enableRemoteSvc({
                server: shard.sdc.primary.server,
                zone: shard.sdc.primary.zoneId,
                fmri: 'manatee-sitter',
                log: log
            }, next);

        },

        function waitPrimaryEnabled(_, next) {
            progress('Waiting for primary manatee to be enabled');
            waitForManatee({
                state: 'primary',
                server: shard.sdc.primary.server,
                manateeUUID: shard.sdc.primary.zoneId,
                log: log,
                leaderIP: leaderIP
            }, next);
        },

        function enableSyncManatee(_, next) {
            if (!shard.sdc.sync) {
                return next();
            }

            progress('Enabling sync manatee');
            enableRemoteSvc({
                server: shard.sdc.sync.server,
                zone: shard.sdc.sync.zoneId,
                fmri: 'manatee-sitter',
                log: log
            }, next);
        },

        function waitSyncEnabled(_, next) {
            if (!shard.sdc.sync) {
                return next();
            }
            progress('Waiting for sync manatee to be enabled');
            waitForManatee({
                state: 'sync',
                server: shard.sdc.primary.server,
                manateeUUID: shard.sdc.primary.zoneId,
                log: log,
                leaderIP: leaderIP
            }, next);
        },

        function enableAsyncManatee(_, next) {
            if (!shard.sdc.async) {
                return next();
            }
            progress('Enabling async manatee');
            enableRemoteSvc({
                server: shard.sdc.async.server,
                zone: shard.sdc.async.zoneId,
                fmri: 'manatee-sitter',
                log: log
            }, next);
        },

        function waitAsyncEnabled(_, next) {
            if (!shard.sdc.async) {
                return next();
            }
            progress('Waiting for async manatee to be enabled');
            waitForManatee({
                state: 'async',
                server: shard.sdc.primary.server,
                manateeUUID: shard.sdc.primary.zoneId,
                log: log,
                leaderIP: leaderIP
            }, next);
        }

    ]}, cb);
}

/**
 * Wait until all the members of the given ZK cluster return 'imok' or
 * timeout after 5 minutes (experienced based value, may want to make it
 * configurable too):
 *
 * @param {Object} opts:
 *          - log {Bunyan Logger}
 *          - ips {Array}: the list of IPs for each one of the ZK cluster
 *          members.
 * @param {Function} callback: of the form f(err).
 */
function wait4ZkOk(opts, callback) {
    var counter = 0;
    var limit = 60;
    function _wait4Zk() {
        vasync.forEachParallel({
            inputs: opts.ips,
            func: function zkInstStatus(ip, next_) {
                var c = format('echo ruok | nc %s 2181; echo ""', ip);
                common.execPlus({
                    cmd: c,
                    log: opts.log
                }, function (err, stdout, stderr) {
                    if (err) {
                        next_(err);
                    } else {
                        next_(null, stdout.trim());
                    }
                });
            }
        }, function (waitErr, results) {
            if (waitErr) {
                return callback(waitErr);
            }
            counter += 1;
            var notOk = results.successes.filter(function (r) {
                return (r !== 'imok');
            });

            if (notOk.length) {
                if (counter < limit) {
                    return setTimeout(_wait4Zk, 5000);
                } else {
                    return callback('Timeout (5min) waiting ' +
                            'for ZK cluster');
                }
            }

            return callback();
        });
    }

    _wait4Zk();
}


/**
 * Wait until all the members of the given ZK cluster have joined the cluster
 * either as 'leader' or 'follower', or timeout after 5 minutes (experienced
 * based value, may want to make it configurable too):
 *
 * @param {Object} opts:
 *          - log {Bunyan Logger}
 *          - ips {Array}: the list of IPs for each one of the ZK cluster
 *          members.
 * @param {Function} callback: of the form f(err).
 */
function wait4ZkCluster(opts, callback) {
    var counter = 0;
    var limit = 60;
    function _wait4ZkMode() {
        vasync.forEachParallel({
            inputs: opts.ips,
            func: function zkInstStatus(ip, next_) {
                var c = format(
                    'echo stat | nc %s 2181 | grep -i "mode"', ip);
                common.execPlus({
                    cmd: c,
                    log: opts.log
                }, function (err, stdout, stderr) {
                    if (err) {
                        // The command throws an error while ZK is
                        // transitioning from standalone to cluster member
                        next_(null, 'transitioning');
                    } else {
                        next_(null,
                            stdout.trim().replace(/^Mode:\s/, ''));
                    }
                });
            }
        }, function (waitErr, results) {
            if (waitErr) {
                return callback(waitErr);
            }
            counter += 1;
            var notOk = results.successes.filter(function (r) {
                return (r !== 'leader' && r !== 'follower');
            });

            if (notOk.length && counter < limit) {
                if (counter < limit) {
                    return setTimeout(_wait4ZkMode, 5000);
                } else {
                    return callback('Timeout (5min) waiting ' +
                            'for ZK cluster');
                }
            }
            return callback();
        });
    }

    _wait4ZkMode();
}

/**
 * Get the IP for the ZK leader instance.
 * @param {Object} opts:
 *          - log {Bunyan Logger}
 *          - ips {Array}: the list of IPs for each one of the ZK cluster
 *          members.
 * @param {Function} callback: of the form f(err, ip).
 */

function getZkLeaderIP(opts, callback) {
    vasync.forEachParallel({
        inputs: opts.ips,
        func: function zkInstStatus(ip, next_) {
            var c = format(
                'echo stat | nc %s 2181 | grep -i "mode"', ip);
            common.execPlus({
                cmd: c,
                log: opts.log
            }, function (err, stdout, stderr) {
                if (err) {
                    // The command throws an error while ZK is
                    // transitioning from standalone to cluster member
                    next_(null, {ip: ip, mode: 'transitioning'});
                } else {
                    next_(null, {
                        ip: ip,
                        mode: stdout.trim().replace(/^Mode:\s/, '')
                    });
                }
            });
        }
    }, function (waitErr, results) {
        if (waitErr) {
            return callback(waitErr);
        }

        var leader = results.successes.filter(function (r) {
            return (r.mode === 'leader');
        });

        var IP = leader.length ? leader[0].ip : null;
        return callback(null, IP);
    });

}

// --- exports

module.exports = {
    getUserScript: getUserScript,
    writeOldUserScriptForRollback: writeOldUserScriptForRollback,
    updateSvcUserScript: updateSvcUserScript,
    updateVmUserScript: updateVmUserScript,
    getOldUserScript: getOldUserScript,
    updateSapiSvc: updateSapiSvc,
    imgadmInstall: imgadmInstall,
    reprovision: reprovision,
    waitForInstToBeUp: waitForInstToBeUp,
    checkHA: checkHA,
    provisionTmpVm: provisionTmpVm,
    waitForTmpInstToBeUp: waitForTmpInstToBeUp,
    getTmpInstanceUUID: getTmpInstanceUUID,
    checkIfTmpVMHasErrors: checkIfTmpVMHasErrors,
    disableVMRegistrar: disableVMRegistrar,
    waitUntilVMNotInDNS: waitUntilVMNotInDNS,
    waitUntilVmInDNS: waitUntilVmInDNS,
    stopTmpVm: stopTmpVm,
    destroyTmpVM: destroyTmpVM,
    createInstance: createInstance,
    imgadmInstallRemote: imgadmInstallRemote,
    reprovisionRemote: reprovisionRemote,
    disableVMRegistrarRemote: disableVMRegistrarRemote,
    updateVmUserScriptRemote: updateVmUserScriptRemote,
    ensureDelegateDataset: ensureDelegateDataset,
    disableManateeSitter: disableManateeSitter,
    enableManateeSitter: enableManateeSitter,
    getShardStatus: getShardStatus,
    restartRemoteSvc: restartRemoteSvc,
    disableRemoteSvc: disableRemoteSvc,
    enableRemoteSvc: enableRemoteSvc,
    wait4ZkOk: wait4ZkOk,
    wait4ZkCluster: wait4ZkCluster,
    getZkLeaderIP: getZkLeaderIP
};
// vim: set softtabstop=4 shiftwidth=4:
