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
var vasync = require('vasync');
var VError = require('verror');

var common = require('../common');
var errors = require('../errors');


// ---- internal support functions


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
 * - `args.channelArg`: Optional. The updates.joyent.com channel to use if
 *   querying updates.joyent.com. It defaults to the default configured
 *   channel (per `sdcadm channel`).
 * - `args.imgArg`: must be one of:
 *      - "latest": to find the latest available image on updates.joyent.com
 *      - "current": the find the latest image already installed in the DC's
 *        local IMGAPI, if any
 *      - a UUID: to find that particular image
 *      - a version string: to find that particular image version
 * - `args.sdcadm`: The SdcAdm object for this run.
 *
 * Output args:
 * - `args.svcImg`: The found image manifest.
 * - `args.needToDownloadImg`: Set to true if the image is not already in the DC
 *   and needs to be downloaded from updates.joyent.com.
 * - `args.channel`: Maybe. If updates.joyent.com was queried (i.e. the image
 *   was not found locally), then this will be set to `args.channelArg` or
 *   resolved to the default channel.
 *
 * If no matching image can be found, this callback with an error.
 */
function findSvcImg(args, cb) {
    assert.string(args.svcName, 'args.svcName');
    assert.optionalString(args.channelArg, 'args.channelArg');
    assert.string(args.imgArg, 'args.imgArg');
    assert.object(args.sdcadm, 'args.sdcadm');

    const sdcadm = args.sdcadm;
    const context = {};

    const imgName = sdcadm.config.imgNameFromSvcName[args.svcName];
    if (!imgName) {
        cb(new VError('could not determine image name for service "%s"',
            args.svcName));
        return;
    }

    vasync.pipeline({
        arg: context,
        funcs: [
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

                sdcadm.imgapi.listImages({
                    name: imgName
                }, function (err, imgs) {
                    if (err) {
                        next(err);
                    } else if (imgs && imgs.length > 0) {
                        // Assumption: these are already sorted by published_at.
                        ctx.svcImg = imgs[imgs.length - 1];
                        ctx.needToDownloadImg = false;
                        next();
                    } else {
                        next(new errors.UpdateError(format(
                            'no "%s" image found in this DC\'s IMGAPI',
                            imgName)));
                    }
                });
            },

            // imgArg=='latest' means look in updates.joyent.com.
            function findImg_Latest(ctx, next) {
                if (args.imgArg !== 'latest') {
                    next();
                    return;
                }

                sdcadm.updates.listImages({
                    name: imgName,
                    channel: ctx.channel
                }, function (listErr, imgs) {
                    if (listErr) {
                        next(listErr);
                    } else if (imgs && imgs.length) {
                        // Assumption: these are already sorted by published_at.
                        ctx.svcImg = imgs[imgs.length - 1];

                        // See if we have this image already in the DC.
                        sdcadm.imgapi.getImage(
                            ctx.svcImg.uuid,
                            function (getErr, img) {
                                if (getErr && getErr.body &&
                                    getErr.body.code === 'ResourceNotFound') {
                                    ctx.needToDownloadImg = true;
                                    next();
                                } else if (getErr) {
                                    next(getErr);
                                } else {
                                    assert.object(img, 'img');
                                    ctx.needToDownloadImg = false;
                                    next();
                                }
                            }
                        );
                    } else {
                        next(new errors.UpdateError(
                            format('no "%s" image found in %s channel of ' +
                                'updates server',
                                imgName, ctx.channel)));
                    }
                });
            },

            // imgArg==<uuid> means look local IMGAPI or updates.joyent.com.
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
                        if (img.name !== imgName) {
                            next(new errors.UpdateError(format(
                                'image "%s" (%s) is not a "%s" image',
                                args.imgArg, img.name, imgName)));
                        } else {
                            ctx.svcImg = img;
                            // `SdcAdm.getImage` doesn't explicitly tell us if
                            // the image is already in the DC, but we can infer
                            // that from `img.channels`. If it has that field,
                            // then it was a response from querying
                            // updates.joyent.com.
                            ctx.needToDownloadImg =
                                img.hasOwnProperty('channels');
                            next();
                        }
                    }
                });
            },

            // imgArg==<version string>
            function findImg_Version(ctx, next) {
                if (ctx.svcImg) {
                    // If `svcImg` is set, then we already found an image above.
                    next();
                    return;
                }

                // Look first in the local DC IMGAPI.
                sdcadm.imgapi.listImages({
                    name: imgName,
                    version: args.imgArg
                }, function (localErr, localImgs) {
                    if (localErr && !(localErr.body &&
                        localErr.body.code === 'ResourceNotFound')) {
                        next(localErr);
                    } else if (!localErr && localImgs && localImgs.length > 0) {
                        // Assumption: these are already sorted by published_at.
                        ctx.svcImg = localImgs[localImgs.length - 1];
                        ctx.needToDownloadImg = false;
                        next();
                    } else {
                        // Fallback to looking in updates.joyent.com.
                        sdcadm.updates.listImages({
                            name: imgName,
                            version: args.imgArg,
                            channel: ctx.channel
                        }, function (updatesErr, updatesImgs) {
                            if (updatesErr) {
                                next(updatesErr);
                            } else if (updatesImgs && updatesImgs.length > 0) {
                                // Assumption: these are already sorted by
                                // published_at.
                                ctx.svcImg = updatesImgs[
                                    updatesImgs.length - 1];
                                ctx.needToDownloadImg = true;
                                next();
                            } else {
                                next(new errors.UpdateError(format(
                                    'no "%s" image with version "%s" ' +
                                    'found in the %s channel of the ' +
                                    'updates server',
                                    imgName, args.imgArg,
                                    ctx.channel)));
                            }
                        });
                    }
                });
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
