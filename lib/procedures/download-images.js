/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var p = console.log;
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');

var Procedure = require('./procedure').Procedure;

function DownloadImages(options) {
    assert.arrayOfObject(options.images, 'options.images');
    this.images = options.images;
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
 * to 'updates.joyent.com?channel=<current-channel>'.
 */
DownloadImages.prototype.execute = function diExecute(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.optionalString(options.source, 'options.source');
    assert.func(options.progress, 'options.progress');
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = options.sdcadm;
    var progress = options.progress;

    var source = options.source;
    if (!source) {
        source = sdcadm.config.updatesServerUrl;
        if (sdcadm.updates.channel) {
            source += '?channel=' + sdcadm.updates.channel;
        }
    }

    /*
     * Limitation: Origin/ancestry handling (`getAncestorsForImages`) doesn't
     * properly handle a custom `options.source`. Instead it assumes it can
     * look up an origin image on updates.joyent.com. For example,
     * `sdcadm post-setup dev-sample-data` uses `options.source` to import
     * some images from images.joyent.com. However, it gets lucky because the
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
     * Keep track of errors during parallel image imports
     */
    var errs = [];


    /*
     * Given an array containing an array of images, this function will
     * recursively call itself until we get the origins for all the images,
     * storing these in arrays of the form:
     * [..., [Arr of origins of level 2], [Arr of origins of level 1], [imgs]]
     *
     * The callback will be called with `f(err, collectionsOfImages)`
     */
    function getAncestorsForImages(colsToRetrieve, callback) {
        var currCol = colsToRetrieve[0];
        var newCol = [];
        vasync.forEachParallel({
            inputs: currCol,
            func: function checkImgOrigin(img, nextImg) {
                if (!img.origin || useCustomSourceCountermeasures) {
                    nextImg();
                    return;
                }

                /*
                 * If we find that the image origin has already been queued for
                 * download, we need to move it up on the download queue, since
                 * we want it downloaded before the image we're evaluating now.
                 */
                var found = false;
                colsToRetrieve.forEach(function (aCol) {
                    var pos;
                    for (pos = 0; pos < aCol.length; pos += 1) {
                        if (aCol[pos].uuid === img.origin) {
                            newCol.push(aCol[pos]);
                            delete (aCol[pos]);
                            found = true;
                        }
                    }
                });
                if (found) {
                    nextImg();
                    return;
                }

                var orig = img.origin;
                sdcadm.imgapi.getImage(orig, function (err, local) {
                    if (!err) {
                        /*
                         * Origin already imported but unactivated.
                         */
                        if (local.state === 'unactivated') {
                            newCol.push(local);
                        }
                        nextImg();
                        return;
                    } else if (err) {
                        if (err.body.code !== 'ResourceNotFound') {
                            nextImg(new errors.SDCClientError(err, 'imgapi'));
                            return;
                        } else {
                            /*
                             * We need to fetch origin details from remote
                             * (origin not imported).
                             */
                            sdcadm.updates.getImage(orig, function (er, rem) {
                                if (er) {
                                    nextImg(new errors.SDCClientError(er,
                                        'updates'));
                                    return;
                                }
                                newCol.push(rem);
                                nextImg();
                            });
                        }
                    }
                });
            }
        }, function paraCb(paraErr) {
            if (paraErr) {
                callback(paraErr);
                return;
            }
            if (newCol.length) {
                var uuids = [];
                newCol = newCol.filter(function (elm) {
                    var isNew = (uuids.indexOf(elm.uuid) === -1);
                    if (isNew) {
                        uuids.push(elm.uuid);
                    }
                    return isNew;
                });
                colsToRetrieve.unshift(newCol);
                getAncestorsForImages(colsToRetrieve, callback);
            } else {
                callback(null, colsToRetrieve);
            }
        });
    }


    function importCollectionOfImages(collection, nextCollection) {
        var concurrency = 4;
        if (useCustomSourceCountermeasures) {
            concurrency = 1;
        }

        var q = vasync.queuev({
            concurrency: concurrency,
            worker: function importUpdateImage(image, next) {
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
                        return nextStep();
                    }

                    progress('Removing unactivated image %s\n(%s@%s)',
                        image.uuid, image.name, image.version);

                    sdcadm.imgapi.deleteImage(image.uuid, function (err) {
                        if (err) {
                            progress(
                                'Error removing unactivated image %s\n(%s@%s)',
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
                        source,
                        {
                            // TODO: Once IMGAPI-408 is sufficient deployed,
                            // then drop this `skipOwnerCheck`.
                            skipOwnerCheck: true,
                            // Retry image import 5 times by default:
                            retries: 5
                        },
                        function (err, img, res) {
                            if (err) {
                                progress('Error importing image %s\n(%s@%s)',
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
                ]}, next);
            }
        });

        function onTaskComplete(err) {
            if (err) {
                errs.push(err);
            }
        }

        q.on('end', function done() {
            nextCollection();
        });

        q.push(collection, onTaskComplete);
        q.close();
    }



    /*
     * TOOLS-1634: We need to make sure that all the origins for
     * all our images are imported and active in local IMGAPI.
     * Additionally, we cannot try to import origins and the images
     * created from those origins in parallel, so we need to import
     * the different level of images ancestors sequentially.
     *
     * We'll use an array of arrays, prepending collections to this array as
     * we go deeper in image's origins. Every origin not already on the local
     * IMGAPI or with a state of 'unactivated' will be imported. Once we have
     * a collection of 'sibiling' origins, we'll normalize that collection
     * (remove duplicates) and prepend to `collectionsToRetrieve`:
     */
    var collectionsToRetrieve = [];
    /*
     * We'll begin with the service images we want to retrieve first,
     * then we'll continue with successive origins.
     */
    collectionsToRetrieve.unshift(self.images);

    getAncestorsForImages(collectionsToRetrieve, function (err, collections) {
        if (err) {
            cb(err);
            return;
        }

        vasync.forEachPipeline({
            inputs: collections,
            func: importCollectionOfImages
        }, function pipeCb(pipeErr) {
            if (pipeErr) {
                cb(pipeErr);
                return;
            }
            var er = (errs.length === 1) ? errs[0] :
                new errors.MultiError(errs);

            // Check if the problem is that external nics are missing.
            if (errs.length) {
                var remoteSourceErr = errs.some(function (e) {
                    return (e && e.we_cause &&
                        e.we_cause.name === 'RemoteSourceError');
                });

                if (remoteSourceErr) {
                    sdcadm.checkMissingExternalNics({
                        progress: progress
                    }, function (nicsErr, res) {
                        if (nicsErr) {
                            return cb(errs);
                        }

                        var doimgapi = res.doimgapi;
                        if (doimgapi) {
                            p('');
                            var msg = 'There is an error trying to download ' +
                                'images because the imgapi zone has no ' +
                                'external NIC.\nPlease run:\n\n' +
                                '   sdcadm post-setup common-external-nics\n' +
                                '\nand try again.\n';
                            p(msg);
                        }
                        // we need to return the error anyway:
                        cb(er);
                        return;
                    });
                } else {
                    cb(er);
                }
            } else {
                cb();
            }
        });
    });
};

//---- exports

module.exports = {
    DownloadImages: DownloadImages
};
// vim: set softtabstop=4 shiftwidth=4:
