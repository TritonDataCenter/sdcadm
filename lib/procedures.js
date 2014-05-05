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
NoOp.prototype.summarize = function summarize() {
    return 'no-op';
};
NoOp.prototype.execute = function execute(options, cb) {
    cb()
};


function DownloadImages(options) {
    assert.arrayOfObject(options.images, 'options.images');
    this.images = options.images;
}
util.inherits(DownloadImages, Procedure);

DownloadImages.prototype.summarize = function summarize() {
    var size = this.images
        .map(function (img) { return img.files[0].size; })
        .reduce(function (prev, curr) { return prev + curr; });
    return sprintf('download %d image%s (%d MiB)',
        this.images.length,
        (this.images.length === 1 ? '' : 's'),
        size / 1024 / 1024);
};

DownloadImages.prototype.execute = function execute(options, cb) {
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
            sdcadm.imgapi.adminImportRemoteImageAndWait(
                image.uuid,
                sdcadm.config.updatesServerUrl,
                {
                    //XXX remove this hack: either need the owner cleanup with
                    //    all-zero's UUID or at least need to be doing the
                    //    owner=$admin replacement here. Else 'sdcadm update'
                    //    is dangerous.
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
            errs.push(err)
        }
    }

    q.on('end', function done() {
        if (errs.length === 1) {
            cb(errs[0]);
        } else if (errs.length) {
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
 */
function UpdateStatelessServicesV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateStatelessServicesV1, Procedure);

UpdateStatelessServicesV1.prototype.summarize = function summarize() {
    return this.changes.map(function (ch) {
        return sprintf('update "%s" service to image %s (%s@%s)',
            ch.service.name, ch.image.uuid, ch.image.name, ch.image.version);
    }).join('\n');
};


UpdateStatelessServicesV1.prototype.execute = function execute(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.plan, 'options.plan');
    assert.object(options.log, 'options.log');
    assert.func(options.logCb, 'options.logCb');
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = options.sdcadm;
    var logCb = options.logCb;
    var log = options.log;

    // For now we'll update services in series.
    // TODO: Should eventually be able to do this in parallel.
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
            // XXX: OS-2275 quota guard per upgrade-all.sh. Let's do this:
            // - config.vmMinPlatform: a min platform version on which we
            //   support deploying sdc core zones. Let's see if we can set
            //   this to the platform after OS-2275 and doc that.
            // - add a guard in `genUpdatePlan`.

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
            function updateSvcUserScript(_, next) {
                if (svc.metadata['user-script'] === userScript) {
                    return next();
                }
                logCb(format('Update "%s" service user-script.', svc.name));
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
                logCb(format('Update "%s" VM %s user-script.', svc.name,
                    inst.zonename));
                log.trace({inst: inst, image: change.image.uuid},
                    'reprovision VM inst');
                var vmadm = spawn('/usr/sbin/vmadm', ['update', inst.zonename]);
                var stdout = [];
                var stderr = [];
                vmadm.stdout.setEncoding('utf8');
                vmadm.stdout.on('data', function (s) { stdout.push(s) });
                vmadm.stderr.setEncoding('utf8');
                vmadm.stderr.on('data', function (s) { stderr.push(s) });
                vmadm.on('close', function vmadmDone(code) {
                    stdout = stdout.join('');
                    stderr = stderr.join('');
                    log.debug({inst: inst, image: change.image.uuid,
                        code: code, stdout: stdout, stderr: stderr},
                        'reprovisioned VM inst');
                    if (code) {
                        var msg = format(
                            'error update VM %s user-script: exit code %s\n'
                            + '    stdout:\n%s'
                            + '    stderr:\n%s',
                            inst.zonename, code,
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
                var img = change.image;
                logCb(format('Installing image %s (%s@%s).', img.uuid,
                    img.name, img.version));

                var argv = ['/usr/sbin/imgadm', 'import', '-q', img.uuid];

                var env = common.objCopy(process.env);
                // Get 'debug' level logging in imgadm >=2.6.0 without triggering trace
                // level logging in imgadm versions before that. Trace level logging is
                // too much here.
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
                            }))
                        }
                        next();
                    });
            },

            function reprovision(_, next) {
                logCb(format('Reprovisioning %s VM %s.', inst.service,
                    inst.zonename));
                log.trace({inst: inst, image: change.image.uuid},
                    'reprovision VM inst');
                var vmadm = spawn(
                    '/usr/sbin/vmadm',
                    ['reprovision', inst.zonename]);
                var stdout = [];
                var stderr = [];
                vmadm.stdout.setEncoding('utf8');
                vmadm.stdout.on('data', function (s) { stdout.push(s) });
                vmadm.stderr.setEncoding('utf8');
                vmadm.stderr.on('data', function (s) { stderr.push(s) });
                vmadm.on('close', function vmadmDone(code) {
                    stdout = stdout.join('');
                    stderr = stderr.join('');
                    log.debug({inst: inst, image: change.image.uuid,
                        code: code, stdout: stdout, stderr: stderr},
                        'reprovisioned VM inst');
                    if (code) {
                        var msg = format(
                            'error reprovisioning VM %s: exit code %s\n'
                            + '    stdout:\n%s'
                            + '    stderr:\n%s',
                            inst.zonename, code,
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

/*

    echo '{}' | json -e "this.image_uuid = '${image_uuid}'" |
        vmadm reprovision ${instance_uuid}
*/

};



/**
 * Return an array of procedure objects that will (in-order) handle the
 * full given update plan. Errors out if the plan cannot be handled (i.e.
 * if this tool doesn't know how to update something yet).
 *
 * @param options {Object}  Required.
 *      - plan {UpdatePlan} Required.
 *      - log {Bunyan Logger} Required.
 * @param cb {Function} Callback of the form `function (err, procs)`.
 */
function coordinatePlan(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.plan, 'options.plan');
    assert.object(options.log, 'options.log');
    assert.func(cb, 'cb');
    var log = options.log;
    var sdcadm = options.sdcadm;

    var instsFromSvcName = {};
    var insts = options.plan.curr;
    for (var i = 0; i < insts.length; i++) {
        var inst = insts[i];
        var svcName = inst.service;
        if (!instsFromSvcName[svcName])
            instsFromSvcName[svcName] = [];
        instsFromSvcName[svcName].push(inst);
    }

    var changes = options.plan.changes.slice();
    var procs = [];
    var images;
    vasync.pipeline({funcs: [
        function coordImages(_, next) {
            var imageFromUuid = {};
            for (var i = 0; i < changes.length; i++) {
                var image = changes[i].image;
                if (image) {
                    imageFromUuid[image.uuid] = image;
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
                            nextImage(err); // XXX wrap err
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
         * Update servers that are (a) stateless, (b) have a single instance
         * **on the headnode**, (c) with no current special handling (like
         * migrations).
         *
         * Here (b) implies this is the early SDC world where we don't have
         * HA multiple instances of services.
         */
        function updateSimpleServices(_, next) {
            var simpleServices = ['vmapi', 'cnapi', 'amon',  'amonredis',
                'sdcsso', 'cloudapi', 'workflow', 'cnapi', 'fwapi', 'napi',
                'papi', 'mahi', 'redis', 'assests', 'ca'];
            var handle = [];
            var remaining = [];
            changes.forEach(function (change) {
                log.debug({change: change}, 'UpdateStatelessServicesV1 look at a change XXX')
                var insts = instsFromSvcName[change.service.name];
                if (change.type === 'update-service' &&
                    ~simpleServices.indexOf(change.service.name))
                {
                    if (insts.length !== 1) {
                        log.debug({
                                numInsts: insts.length,
                                svc: change.service.name
                            }, 'UpdateStatelessServicesV1 skip change: ' +
                            'not 1 inst');
                    /* XXX make this be check of the `server` uuid */
                    } else if (insts[0].hostname !== 'headnode') {
                        log.debug({
                                svc: change.service.name,
                                cn: insts[0].server
                            }, 'UpdateStatelessServicesV1 skip change: ' +
                            'inst not on headnode');
                    } else {
                        change.inst = insts[0];
                        handle.push(change);
                    }
                } else {
                    remaining.push(change);
                }
            });
            if (handle.length) {
                changes = remaining;
                log.debug({changes: handle}, //XXX trim down `handle`
                    'UpdateStatelessServicesV1 will handle %d change(s)',
                    handle.length);
                procs.push(new UpdateStatelessServicesV1({
                    changes: handle
                }));
            }
            next();
        },

        // XXX: last is to purge unused core images (housekeeping)
        //      Plan: if can, add a marker (tag?) to images imported by
        //      'sdcadm' so know that we can feel more confident removing
        //      these ones. Can't think of current use cases for not
        //      purging images. Add a boolean config to not do this at all.
        //      Add a separate 'sdcadm purge-images/cleanup-images' or
        //      something.
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
                .map(function (c) { return JSON.stringify(c) })
                .join('\n    ');
            cb(new errors.UpdateError(
                'do not yet support the following changes:\n    ' + summary));
        } else {
            cb(null, procs);
        }
    });
};


//---- exports

module.exports = {
    coordinatePlan: coordinatePlan
};
// vim: set softtabstop=4 shiftwidth=4:
