/*
 * Copyright (c) 2014 Joyent Inc. All rights reserved.
 *
 * The collection of "procedure" functions that know how to perform part of
 * an update plan (i.e. for `sdcadm update`).
 */

var p = console.log;
var assert = require('assert-plus');
var child_process = require('child_process'),
    exec = child_process.exec,
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var fs = require('fs');
var once = require('once');
var os = require('os');
var path = require('path');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var vasync = require('vasync');
var verror = require('verror');

var common = require('./common');
var errors = require('./errors'),
    InternalError = errors.InternalError;



//---- internal support stuff



//---- exported "procedures"

function Procedure() {}
Procedure.prototype.summarize = function summarize() {};
Procedure.prototype.execute = function execute(options, cb) {};


function NoOp() {}
NoOp.prototype.summarize = function noOpSummarize() {
    return 'no-op';
};
NoOp.prototype.execute = function noOpExecute(options, cb) {
    cb();
};


function DownloadImages(options) {
    assert.arrayOfObject(options.images, 'options.images');
    this.images = options.images;
}
util.inherits(DownloadImages, Procedure);

DownloadImages.prototype.summarize = function diSummarize() {
    var size = this.images
        .map(function (img) { return img.files[0].size; })
        .reduce(function (prev, curr) { return prev + curr; });
    var imageInfos = this.images.map(function (img) {
        return format('image %s (%s@%s)', img.uuid, img.name, img.version);
    });
    return sprintf('download %d image%s (%d MiB):\n%s',
        this.images.length,
        (this.images.length === 1 ? '' : 's'),
        size / 1024 / 1024,
        common.indent(imageInfos.join('\n')));
};

DownloadImages.prototype.execute = function diExecute(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.plan, 'options.plan');
    assert.object(options.log, 'options.log');
    assert.func(options.logCb, 'options.logCb');
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = options.sdcadm;
    var logCb = options.logCb;

    var q = vasync.queuev({
        concurrency: 4,
        worker: function importUpdateImage(image, next) {
            logCb(format('Importing image %s (%s@%s)', image.uuid,
                image.name, image.version));
            // TODO: pass in update_channel here
            sdcadm.imgapi.adminImportRemoteImageAndWait(
                image.uuid,
                sdcadm.config.updatesServerUrl,
                {
                    // TODO: Once IMGAPI-408 is sufficient deployed, then drop
                    // this `skipOwnerCheck`.
                    skipOwnerCheck: true
                },
                function (err, img, res) {
                    if (err) {
                        logCb(format('Error importing image %s (%s@%s)',
                            image.uuid, image.name, image.version));
                        var e = new errors.SDCClientError(err, 'imgapi');
                        e.image = image.uuid;
                        next(e);
                    } else {
                        logCb(format('Imported image %s (%s@%s)', image.uuid,
                            image.name, image.version));
                        next();
                    }
                });
        }
    });

    // TODO: For now we just collect import errors and return them. We
    //       should do better with retries (either here or in the imgapi
    //       client).
    var errs = [];
    function onTaskComplete(err) {
        if (err) {
            errs.push(err);
        }
    }

    q.on('end', function done() {
        if (errs.length === 1) {
            cb(errs[0]);
        } else if (errs.length > 1) {
            cb(new errors.MultiError(errs));
        } else {
            cb();
        }
    });

    for (var i = 0; i < self.images.length; i++) {
        q.push(self.images[i], onTaskComplete);
    }
    q.close();
};


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
                var userScriptPath = path.resolve(__dirname, '..',
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
                var vmadm = spawn('/usr/sbin/vmadm', ['update', inst.zonename]);
                var stdout = [];
                var stderr = [];
                vmadm.stdout.setEncoding('utf8');
                vmadm.stdout.on('data', function (s) { stdout.push(s); });
                vmadm.stderr.setEncoding('utf8');
                vmadm.stderr.on('data', function (s) { stderr.push(s); });
                vmadm.on('close', function vmadmDone(code, signal) {
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
                vmadm.stdin.setEncoding('utf8');
                vmadm.stdin.write(JSON.stringify({
                    customer_metadata: {
                        'user-script': userScript
                    }
                }));
                vmadm.stdin.end();
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
                logCb(format('Reprovisioning %s VM %s', inst.service,
                    inst.zonename));
                log.trace({inst: inst, image: change.image.uuid},
                    'reprovision VM inst');
                var vmadm = spawn(
                    '/usr/sbin/vmadm',
                    ['reprovision', inst.zonename]);
                var stdout = [];
                var stderr = [];
                vmadm.stdout.setEncoding('utf8');
                vmadm.stdout.on('data', function (s) { stdout.push(s); });
                vmadm.stderr.setEncoding('utf8');
                vmadm.stderr.on('data', function (s) { stderr.push(s); });
                vmadm.on('close', function vmadmDone(code, signal) {
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
                vmadm.stdin.setEncoding('utf8');
                vmadm.stdin.write(JSON.stringify({
                    image_uuid: change.image.uuid
                }));
                vmadm.stdin.end();
            }
        ]}, nextSvc);
    }
};



/**
 * Return an array of procedure objects that will (in-order) handle the
 * full given update plan. Errors out if the plan cannot be handled (i.e.
 * if this tool doesn't know how to update something yet).
 *
 * @param opts {Object}  Required.
 *      - plan {UpdatePlan} Required.
 *      - log {Bunyan Logger} Required.
 *      - serverFromUuidOrHostname {Object} Required.
 * @param cb {Function} Callback of the form `function (err, procs)`.
 */
function coordinatePlan(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.serverFromUuidOrHostname,
        'opts.serverFromUuidOrHostname');
    assert.func(cb, 'cb');
    var log = opts.log;
    var sdcadm = opts.sdcadm;

    var instsFromSvcName = {};
    var insts = opts.plan.curr;
    for (var i = 0; i < insts.length; i++) {
        var inst = insts[i];
        var svcName = inst.service;
        if (!instsFromSvcName[svcName]) {
            instsFromSvcName[svcName] = [];
        }
        instsFromSvcName[svcName].push(inst);
    }

    var changes = opts.plan.changes.slice();
    var procs = [];
    vasync.pipeline({funcs: [
        function coordImages(_, next) {
            var imageFromUuid = {};
            for (var c = 0; c < changes.length; c++) {
                var img = changes[c].image;
                if (img) {
                    imageFromUuid[img.uuid] = img;
                }
            }
            var images = Object.keys(imageFromUuid).map(
                function (uuid) { return imageFromUuid[uuid]; });
            var imagesToRetrieve = [];
            vasync.forEachParallel({
                inputs: images,
                func: function imageExists(image, nextImage) {
                    sdcadm.imgapi.getImage(image.uuid, function (err, local) {
                        if (err && err.body.code === 'ResourceNotFound') {
                            imagesToRetrieve.push(image);
                            nextImage();
                        } else if (err) {
                            nextImage(new errors.SDCClientError(err, 'imgapi'));
                        } else {
                            nextImage();
                        }
                    });
                }
            }, function (err) {
                if (err) {
                    return next(err);
                }
                if (imagesToRetrieve.length > 0) {
                    procs.push(new DownloadImages({images: imagesToRetrieve}));
                }
                next();
            });
        },

        /**
         * Update services that are (a) stateless, (b) have a single instance
         * **on the headnode**, (c) with no current special handling (like
         * migrations).
         *
         * Here (b) implies this is the early SDC world where we don't have
         * HA multiple instances of services.
         */
        function updateSimpleServices(_, next) {
            var simpleServices = ['vmapi', 'amon',  'amonredis',
                'sdcsso', 'cloudapi', 'workflow', 'cnapi', 'fwapi', 'napi',
                'papi', 'mahi', 'redis', 'assets', 'ca', 'sdc'];
            var handle = [];
            var remaining = [];
            var currHostname = os.hostname();
            changes.forEach(function (change) {
                var svcInsts = instsFromSvcName[change.service.name] || [];
                if (change.type === 'update-service' &&
                    ~simpleServices.indexOf(change.service.name))
                {
                    if (svcInsts.length !== 1) {
                        log.debug({
                                numInsts: svcInsts.length,
                                svc: change.service.name
                            }, 'UpdateStatelessServicesV1 skip change: ' +
                            'not 1 inst');
                    } else if (svcInsts[0].hostname !== currHostname) {
                        log.debug({
                                svc: change.service.name,
                                cn: svcInsts[0].server
                            }, 'UpdateStatelessServicesV1 skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = svcInsts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle},
                    'UpdateStatelessServicesV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateStatelessServicesV1({
                    changes: handle
                }));
            }
            next();
        }

        // TODO: last is to purge unused core images (housekeeping)
        //      Plan: if can, add a marker (tag?) to images imported by
        //      'sdcadm' so know that we can feel more confident removing
        //      these ones. Can't think of current use cases for not
        //      purging images. Add a boolean config to not do this at all.
        //      Add a separate 'sdcadm purge-images/cleanup-images' or
        //      something.
        // TODO: Also purge older unused images *on the CN zpools*.
    ]}, function done(err) {
        if (err) {
            cb(err);
        } else if (changes.length) {
            var summary = changes
                .map(function (c) {
                    var sum = {};
                    if (c.type) { sum.type = c.type; }
                    if (c.service) { sum.service = c.service.name; }
                    if (c.image) { sum.image = c.image.uuid; }
                    return sum;
                })
                .map(function (c) { return JSON.stringify(c); })
                .join('\n    ');
            cb(new errors.UpdateError(
                'do not support the following changes:\n    ' + summary));
        } else {
            if (opts.plan.justImages) {
                procs = procs.filter(function (proc) {
                    return proc.constructor.name === 'DownloadImages';
                });
            }
            cb(null, procs);
        }
    });
}


//---- exports

module.exports = {
    coordinatePlan: coordinatePlan
};
// vim: set softtabstop=4 shiftwidth=4:
