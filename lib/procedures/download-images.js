/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 */

/*
 * A `Procedure` to download/import a set of given images (typically from
 * updates.tritondatacenter.com) into the DC's IMGAPI. It attempts to
 * parallelize some of the downloads.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var vasync = require('vasync');
var VError = require('verror');

var common = require('../common');
var errors = require('../errors');
var Procedure = require('./procedure').Procedure;


function DownloadImages(options) {
    assert.arrayOfObject(options.images, 'options.images');
    assert.optionalString(options.channel, 'options.channel');
    this.images = options.images;
    this.channel = options.channel;
}
util.inherits(DownloadImages, Procedure);

/*
 * Limitation: This doesn't list or include the size of *origin* images that
 * might also need to be downloaded.
 */
DownloadImages.prototype.summarize = function diSummarize() {
    var size = this.images.map(function (img) {
        return (img.files.length ? img.files[0].size : 0);
    }).reduce(function (prev, curr) {
        return prev + curr;
    });
    var imageInfos = this.images.map(function (img) {
        return format('image %s\n    (%s@%s)', img.uuid, img.name, img.version);
    });
    return sprintf('download %d image%s (%d MiB):\n%s',
        this.images.length,
        (this.images.length === 1 ? '' : 's'),
        size / 1024 / 1024,
        common.indent(imageInfos.join('\n')));
};

/**
 * The 'source' URL (IMGAPI endpoint) can optionally be passed in. It defaults
 * to 'https://updates.tritondatacenter.com?channel=<current-channel>'.
 */
DownloadImages.prototype.execute = function diExecute(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.optionalString(options.source, 'options.source');
    assert.func(options.progress, 'options.progress');
    assert.func(cb, 'cb');

    var log = options.log;
    var self = this;
    var sdcadm = options.sdcadm;
    var progress = options.progress;

    var source = options.source;
    if (!source) {
        source = sdcadm.config.updatesServerUrl;
        if (self.channel) {
            source += '?channel=' + self.channel;
        } else if (sdcadm.updates.channel) {
            source += '?channel=' + sdcadm.updates.channel;
        }
    }

    /*
     * Limitation: Origin/ancestry handling (`gatherImageGenerations`) doesn't
     * properly handle a custom `options.source`. Instead it assumes it can
     * look up an origin image on updates.tritondatacenter.com. For example,
     * `sdcadm post-setup dev-sample-data` uses `options.source` to import
     * some images from *images.smartos.org*. However, it gets lucky because the
     * images it is pulling do not have origins (they aren't incremental).
     *
     * A *workaround* for this is to (a) avoid looking up origin images (b/c
     * we are using the wrong source) and (b) only import images *serially*
     * (which allows IMGAPI to handle importing the origin ancestry without
     * a race).
     *
     * Dev Note: A better fix (for another time) would be to create an IMGAPI
     * client for the given custom source and use that instead of
     * `sdcadm.updates` when looking up origins.
     */
    var useCustomSourceCountermeasures = false;
    if (options.source) {
        var imgsWithAnOrigin = self.images.filter(function (img) {
            return Boolean(img.origin);
        });
        if (imgsWithAnOrigin.length) {
            useCustomSourceCountermeasures = true;
        }
    }

    /*
     * Gotchas to watch out for when downloading/importing images:
     * - There might be stale "state=unactivated" images sitting in IMGAPI. We
     *   want to re-import those if we hit them.
     * - If there are common origins in the parentage of the `self.images` to
     *   import, then importing them in parallel can cause a race that breaks
     *   import. Say we are importing images C and D that both have
     *   `origin = B`. If we ask IMGAPI to import C and D in parallel, then
     *   IMGAPI will race attempting to import B and the loser of the race will
     *   break.
     *
     * To deal with common origins we'll gather the ancestry of the images
     * to import and import in blocks of one generation at a time, starting
     * from the oldest generation.
     *
     *              A           <--- oldest generation (import these first)
     *             / \
     *            B   \         <--- previous generation (... then these)
     *           / \   \
     *          C  D    E       <--- given set of images (... and finally these)
     *
     * within each generation we can import in parallel.
     */
    var generations = [
        self.images.slice()
    ];

    gatherImageGenerations({
        generations: generations,
        sdcadm: sdcadm,
        useCustomSourceCountermeasures: useCustomSourceCountermeasures
    }, function (gatherErr) {
        if (gatherErr) {
            cb(gatherErr);
            return;
        }

        // Log a summary (elide irrelevant img fields) of the generations
        // to import.
        if (log.debug()) {
            var summary = generations.map(function (gen) {
                return gen.map(function (img) {
                    return {
                        uuid: img.uuid,
                        name: img.name,
                        version: img.version,
                        origin: img.origin
                    };
                });
            });
            log.debug({generations: summary}, 'DownloadImages: generations');
        }

        var concurrency = 4;
        if (useCustomSourceCountermeasures) {
            concurrency = 1;
        }

        vasync.forEachPipeline({
            inputs: generations,
            func: function importOneGen(gen, nextGen) {
                importSetOfImages({
                    concurrency: concurrency,
                    imgs: gen,
                    progress: progress,
                    sdcadm: sdcadm,
                    source: source
                }, nextGen);
            }
        }, function doneGens(genErr) {
            if (genErr) {
                /*
                 * A common source of errors is that someone tries to
                 * 'sdcadm up' on a DC with an IMGAPI that has no external
                 * access. Let's try to give a nicer error message for that
                 * case.
                 */
                if (VError.findCauseByName(genErr, 'RemoteSourceError')) {
                    sdcadm.checkMissingNics({
                        svcNames: ['imgapi'],
                        nicTag: 'external'
                    }, function (checkErr, nicLists) {
                        if (checkErr) {
                            cb(VError.errorFromList([genErr, checkErr]));
                            return;
                        }

                        if (nicLists.instsWithNic.length === 0) {
                            progress(
                                '* * *\n' +
                                'There was an error trying to download ' +
                                    'images because the imgapi zone has no\n' +
                                'external NIC. Please run the following and ' +
                                    'try again:\n' +
                                '    sdcadm post-setup common-external-nics\n' +
                                '* * *'
                            );
                        }
                        cb(genErr);
                    });
                } else {
                    cb(genErr);
                }
            } else {
                cb();
            }
        });
    });
};


/*
 * Each element in `args.generations` is an array of image objects (one
 * generation). This function prepends generations to the array (modifying
 * *in place*), until there are no more origins, or they are already
 * in the local IMGAPI.
 *
 * @param {Object} args
 *      - {Array} args.generations - The current stack of generations.
 *      - {Boolean} args.useCustomSourceCountermeasures
 * @param {Function} cb - `function (err)`
 */
function gatherImageGenerations(args, cb) {
    assert.arrayOfArray(args.generations, 'args.generations');
    assert.bool(args.useCustomSourceCountermeasures,
        'args.useCustomSourceCountermeasures');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.func(cb, 'cb');

    /*
     * In this pass of the function we will fill out the `parentGen`eration,
     * and then call ourself recursively for the next.
     */
    var currGen = args.generations[0];
    var parentGen = [];
    var sdcadm = args.sdcadm;

    vasync.forEachParallel({
        inputs: currGen,
        func: function checkImgOrigin(img, nextImg) {
            if (!img.origin || args.useCustomSourceCountermeasures) {
                nextImg();
                return;
            }

            /*
             * If we find this image's origin in a younger generation (see
             * image "A" in the diagram above), we need to move it up to
             * this older generation so that it is downloaded before `currGen`.
             */
            var found = false;
            args.generations.forEach(function (youngerGen) {
                for (var i = 0; i < youngerGen.length; i += 1) {
                    if (youngerGen[i].uuid === img.origin) {
                        parentGen.push(youngerGen[i]);
                        delete youngerGen[i];
                        found = true;
                        break;
                    }
                }
            });
            if (found) {
                nextImg();
                return;
            }

            // If the origin is already in the local IMGAPI, we can skip it.
            sdcadm.imgapi.getImage(img.origin, function (localErr, localImg) {
                if (!localErr) {
                    /*
                     * An 'unactivated' image is possibly stale, we will
                     * re-import it.
                     */
                    if (localImg.state === 'unactivated') {
                        parentGen.push(localImg);
                    }
                    nextImg();
                } else if (
                    localErr.body &&
                    localErr.body.code === 'ResourceNotFound'
                ) {
                    /*
                     * 404. We don't have the image locally. Get the image obj
                     * from the remote source to be imported.
                     */
                    sdcadm.updates.getImage(img.origin, function (
                        remoteErr,
                        remoteImg
                    ) {
                        if (remoteErr) {
                            nextImg(new errors.SDCClientError(remoteErr,
                                'updates'));
                            return;
                        }
                        parentGen.push(remoteImg);
                        nextImg();
                    });
                } else {
                    nextImg(new errors.SDCClientError(localErr, 'imgapi'));
                }
            });
        }
    }, function finishedParentGen(parentGenErr) {
        if (parentGenErr) {
            cb(parentGenErr);
            return;
        }
        if (parentGen.length) {
            var uuids = [];
            parentGen = parentGen.filter(function (elm) {
                var isNew = (uuids.indexOf(elm.uuid) === -1);
                if (isNew) {
                    uuids.push(elm.uuid);
                }
                return isNew;
            });
            args.generations.unshift(parentGen);
            gatherImageGenerations(args, cb);
        } else {
            cb(null);
        }
    });
}


/*
 * Import the given set of image objects (`args.imgs`) with the given
 * concurrency.
 *
 * @param {Object} args
 *      - {Array} args.imgs - The array of image objects to import.
 *      - {String} args.source - The source IMGAPI URL.
 *      - {Number} args.concurrency - An integer number of images to import at
 *        the same time.
 *      - {Object} args.sdcadm - SdcAdm object.
 *      - {Function} args.progress - Progress output function.
 * @param {Function} cb - called as `cb(err)` where `err` is null or
 *      a single error, or a `verror.MultiError` if multiple concurrent imports
 *      failed.
 *
 * Dev Note: If there are multiple errors, then `err` will be a
 * `verror.MultiError` -- which is different from a `errors.MultiError`.
 * This is an unfortunate middle ground, until sdcadm transitions from
 * its "errors.js" wrappers to raw VError instances using facilities
 * in verror v1.7.0 (see RFD 41).
 */
function importSetOfImages(args, cb) {
    assert.arrayOfObject(args.imgs, 'args.imgs');
    assert.string(args.source, 'args.source');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.func(args.progress, 'args.progress');
    assert.finite(args.concurrency, 'args.concurrency');
    assert.func(cb, 'cb');

    var errs = [];
    var progress = args.progress;
    var sdcadm = args.sdcadm;

    var q = vasync.queuev({
        concurrency: args.concurrency,
        worker: function importAnImage(image, nextImg) {
            /*
             * Need to be verified here b/c there are callers other than
             * procedures/index.js calling DownloadImages.
             */
            function checkIfImageIsUnactivated(_, nextStep) {
                if (image.state === 'unactivated') {
                    nextStep();
                    return;
                }
                sdcadm.imgapi.getImage(image.uuid, function (err, local) {
                    if (err && err.body.code === 'ResourceNotFound') {
                        nextStep();
                    } else if (err) {
                        nextStep(new errors.SDCClientError(err, 'imgapi'));
                    } else {
                        if (local.state === 'unactivated') {
                            // Let DownloadImages know that it has to
                            // remove the image first:
                            image.state = 'unactivated';
                        }
                        nextStep();
                    }
                });
            }

            function deleteImage(_, nextStep) {
                if (image.state !== 'unactivated') {
                    nextStep();
                    return;
                }

                progress('Removing unactivated image %s\n(%s@%s)',
                    image.uuid, image.name, image.version);

                sdcadm.imgapi.deleteImage(image.uuid, function (err) {
                    if (err) {
                        progress('Error removing unactivated image %s\n(%s@%s)',
                            image.uuid, image.name, image.version);

                        var e = new errors.SDCClientError(err, 'imgapi');
                        e.image = image.uuid;
                        sdcadm.log.error({err: e}, 'Error removing image');
                        nextStep(e);
                    } else {
                        nextStep();
                    }
                });
            }

            function getImage(_, nextStep) {
                progress('Downloading image %s\n    (%s@%s)',
                    image.uuid, image.name, image.version);
                sdcadm.imgapi.adminImportRemoteImageAndWait(
                    image.uuid,
                    args.source,
                    {
                        // TODO: Once IMGAPI-408 is sufficient deployed,
                        // then drop this `skipOwnerCheck`.
                        skipOwnerCheck: true,
                        // Retry image import 5 times by default:
                        retries: 5
                    },
                    function (err, _img, res) {
                        if (err) {
                            progress('Error importing image %s\n    (%s@%s)',
                                image.uuid, image.name, image.version);
                            var e = new errors.SDCClientError(err,
                                'imgapi');
                            e.image = image.uuid;
                            nextStep(e);
                        } else {
                            progress('Imported image %s\n    (%s@%s)',
                                image.uuid, image.name, image.version);
                            nextStep();
                        }
                    });
            }

            vasync.pipeline({funcs: [
                checkIfImageIsUnactivated,
                deleteImage,
                getImage
            ]}, nextImg);
        }
    });

    function onTaskComplete(err) {
        if (err) {
            errs.push(err);
            /*
             * Don't start more tasks. After a single image import failure
             * we want to fail reasonably fast, i.e. *not* wait for another
             * N image imports to be started from the queue.
             */
            q.kill();
        }
    }

    q.on('end', function done() {
        cb(VError.errorFromList(errs));
    });

    q.push(args.imgs, onTaskComplete);
    q.close();
}


// --- exports

module.exports = {
    DownloadImages: DownloadImages
};
// vim: set softtabstop=4 shiftwidth=4:
