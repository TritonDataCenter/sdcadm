/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * Steps for doing some things with images, like finding an appropriate image
 * for a new service, or for an upgrade.
 */

var assert = require('assert-plus');
var format = require('util').format;
var tabula = require('tabula');
var vasync = require('vasync');
var VError = require('verror');

var common = require('../common');
var errors = require('../errors');


// ---- internal support functions

/*
 * Look in the given `source` IMGAPI for the latest (by published_at) image
 * matching any of the given `queries`.
 * If any matches are found it calls back `cb(null, img)`.
 * If no matching images are found it calls back `cb(null, null)`.
 * If an error calling the source, it calls back `cb(err)`.
 */
function findLatestMatchingImg(source, queries, cb) {
    assert.object(source, 'source');
    assert.arrayOfObject(queries, 'queries');
    assert.func(cb, 'cb');

    var hits = [];

    vasync.forEachParallel({
        inputs: queries,
        func: function queryAnImgapi(query, nextQuery) {
            source.listImages(query, function (err, imgs) {
                if (err) {
                    nextQuery(err);
                } else {
                    if (imgs) {
                        hits = hits.concat(imgs);
                    }
                    nextQuery();
                }
            });
        }
    }, function pickLatest(err) {
        if (err) {
            cb(err);
        } else if (hits.length === 0) {
            cb(null, null);
        } else {
            tabula.sortArrayOfObjects(hits, ['published_at']);
            cb(null, hits[hits.length - 1]);
        }
    });
}


// ---- steps

/**
 * Find an appropriate image for a service.
 *
 * Note that "the latest" image is always determined by sorting by
 * "published_at".
 *
 * Input args:
 * - `args.svcName`: The SAPI service name. This determines the appropriate
 *   image name.
 * - `args.imgNames`: Optional. An array of image names to consider for this
 *   service.
 * - `args.channelArg`: Optional. The updates.tritondatacenter.com channel to use if
 *   querying updates.tritondatacenter.com. It defaults to the default configured
 *   channel (per `sdcadm channel`).
 * - `args.imgArg`: must be one of:
 *      - "latest": to find the latest available image on updates.tritondatacenter.com
 *      - "current": the find the latest image already installed in the DC's
 *        local IMGAPI, if any
 *      - a UUID: to find that particular image
 *      - a version string: to find that particular image version
 * - `args.sdcadm`: The SdcAdm object for this run.
 *
 * Output args:
 * - `args.svcImg`: The found image manifest.
 * - `args.needToDownloadImg`: Set to true if the image is not already in the DC
 *   and needs to be downloaded from updates.tritondatacenter.com.
 * - `args.channel`: Maybe. If updates.tritondatacenter.com was queried (i.e. the image
 *   was not found locally), then this will be set to `args.channelArg` or
 *   resolved to the default channel.
 *
 * If no matching image can be found, this callback with an error.
 */
function findSvcImg(args, cb) {
    assert.object(args, 'args');
    assert.string(args.svcName, 'args.svcName');
    assert.optionalArrayOfString(args.imgNames, 'args.imgNames');
    assert.optionalString(args.channelArg, 'args.channelArg');
    assert.string(args.imgArg, 'args.imgArg');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.func(cb, 'cb');

    const sdcadm = args.sdcadm;
    const context = {};

    vasync.pipeline({
        arg: context,
        funcs: [
            function getImgNames(ctx, next) {
                if (args.imgNames) {
                    ctx.imgNames = args.imgNames;
                    next();
                } else {
                    sdcadm.imgNamesFromSvcName(args.svcName,
                        function (err, imgNames) {
                            if (err) {
                                next(err);
                            } else if (!imgNames) {
                                next(new VError(
                                    'could not determine image name for ' +
                                        'service "%s"',
                                    args.svcName));
                            } else {
                                ctx.imgNames = imgNames;
                                next();
                            }
                        }
                    );
                }
            },

            // Note: It should be possible to avoid querying for the channel
            // in some cases (e.g. if imgArg=current), but for now we just get
            // it everytime.
            function getChannel(ctx, next) {
                if (!args.channelArg) {
                    sdcadm.getDefaultChannel(function (err, channel) {
                        if (err) {
                            next(err);
                            return;
                        }
                        ctx.channel = channel;
                        next();
                    });
                } else {
                    ctx.channel = args.channelArg;
                    next();
                }
            },

            // imgArg=='current' means look in the local IMGAPI.
            function findImg_Current(ctx, next) {
                if (args.imgArg !== 'current') {
                    next();
                    return;
                }

                findLatestMatchingImg(
                    sdcadm.imgapi,
                    ctx.imgNames.map(function (n) { return {name: n}; }),
                    function (err, img) {
                        if (err) {
                            next(err);
                        } else if (!img) {
                            next(new errors.UpdateError(format(
                                'no image with name "%s" found in ' +
                                    'this DC\'s IMGAPI',
                                ctx.imgNames.join('" or "'))));
                        } else {
                            ctx.svcImg = img;
                            ctx.needToDownloadImg = false;
                            next();
                        }
                    }
                );
            },

            // imgArg=='latest' means look in updates.tritondatacenter.com.
            function findImg_Latest(ctx, next) {
                if (args.imgArg !== 'latest') {
                    next();
                    return;
                }

                findLatestMatchingImg(
                    sdcadm.updates,
                    ctx.imgNames.map(function (n) {
                        return {name: n, channel: ctx.channel};
                    }),
                    function (err, img) {
                        if (err) {
                            next(err);
                        } else if (!img) {
                            next(new errors.UpdateError(format(
                                'no image with name "%s" found in "%s" ' +
                                    'channel of updates server',
                                ctx.imgNames.join('" or "'),
                                ctx.channel)));
                        } else {
                            ctx.svcImg = img;

                            // See if we have this image already in the DC.
                            sdcadm.imgapi.getImage(
                                ctx.svcImg.uuid,
                                function (getErr, localImg) {
                                    if (getErr && getErr.body &&
                                        getErr.body.code ===
                                            'ResourceNotFound') {
                                        ctx.needToDownloadImg = true;
                                        next();
                                    } else if (getErr) {
                                        next(getErr);
                                    } else {
                                        assert.object(localImg, 'localImg');
                                        ctx.needToDownloadImg = false;
                                        next();
                                    }
                                }
                            );
                        }
                    }
                );
            },

            // imgArg==<uuid> means look local IMGAPI or updates.tritondatacenter.com.
            function findImg_Uuid(ctx, next) {
                if (!common.UUID_RE.test(args.imgArg)) {
                    next();
                    return;
                }

                sdcadm.getImage({
                    uuid: args.imgArg,
                    channel: ctx.channel
                }, function (err, img) {
                    if (err && err.body &&
                        err.body.code === 'ResourceNotFound') {
                        next(new errors.UpdateError(format(
                            'no image "%s" was found in the %s channel of' +
                            ' the updates server',
                            args.imgArg, ctx.channel)));
                    } else if (err) {
                        next(err);
                    } else {
                        assert.object(img, 'img');
                        if (ctx.imgNames.indexOf(img.name) === -1) {
                            next(new errors.UpdateError(format(
                                'invalid name for image "%s", ' +
                                    'must be "%s": "%s"',
                                args.imgArg,
                                ctx.imgNames.join('" or "'),
                                img.name)));
                        } else {
                            ctx.svcImg = img;
                            // `SdcAdm.getImage` doesn't explicitly tell us if
                            // the image is already in the DC, but we can infer
                            // that from `img.channels`. If it has that field,
                            // then it was a response from querying
                            // updates.tritondatacenter.com.
                            ctx.needToDownloadImg =
                                img.hasOwnProperty('channels');
                            next();
                        }
                    }
                });
            },

            // imgArg==<version string>, first try in local IMGAPI
            function findImg_VersionLocal(ctx, next) {
                if (ctx.svcImg) {
                    // If `svcImg` is set, then we already found an image above.
                    next();
                    return;
                }

                findLatestMatchingImg(
                    sdcadm.imgapi,
                    ctx.imgNames.map(function (n) {
                        return {name: n, version: args.imgArg};
                    }),
                    function (err, img) {
                        if (err) {
                            next(err);
                        } else if (!img) {
                            next();
                        } else {
                            ctx.svcImg = img;
                            ctx.needToDownloadImg = false;
                            next();
                        }
                    }
                );
            },

            // imgArg==<version string>, try in updates.tritondatacenter.com if needed
            function findImg_VersionRemote(ctx, next) {
                if (ctx.svcImg) {
                    // If `svcImg` is set, then we already found an image above.
                    next();
                    return;
                }

                findLatestMatchingImg(
                    sdcadm.updates,
                    ctx.imgNames.map(function (n) {
                        return {
                            name: n,
                            version: args.imgArg,
                            channel: ctx.channel
                        };
                    }),
                    function (err, img) {
                        if (err) {
                            next(err);
                        } else if (!img) {
                            next(new errors.UpdateError(format(
                                'no image with name "%s" and with ' +
                                'version "%s" found in the "%s" channel of ' +
                                'the updates server',
                                ctx.imgNames.join('" or "'),
                                args.imgArg,
                                ctx.channel)));
                        } else {
                            ctx.svcImg = img;
                            ctx.needToDownloadImg = true;
                            next();
                        }
                    }
                );
            }
        ]
    }, function finish(err) {
        if (err) {
            cb(err);
        } else {
            assert.object(context.svcImg, 'context.svcImg');
            assert.bool(context.needToDownloadImg, 'context.needToDownloadImg');

            // Set output args.
            args.channel = context.channel;
            args.svcImg = context.svcImg;
            args.needToDownloadImg = context.needToDownloadImg;

            cb();
        }
    });
}


// --- exports

module.exports = {
    findSvcImg: findSvcImg
};

// vim: set softtabstop=4 shiftwidth=4:
