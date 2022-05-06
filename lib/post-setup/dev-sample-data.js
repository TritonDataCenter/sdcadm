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
 * 'sdcadm post-setup dev-sample-data'
 */

var assert = require('assert-plus');
var format = require('util').format;
var fs = require('fs');
var path = require('path');
var tabula = require('tabula');
var vasync = require('vasync');

var DownloadImages = require('../procedures/download-images').DownloadImages;
var errors = require('../errors');


// --- internal support stuff

function addDevSampleData(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');

    vasync.pipeline({funcs: [
        function ensureSdcApp(_, nextFun) {
            opts.sdcadm.ensureSdcApp({}, nextFun);
        },
        function addSampleData(_, nextFun) {
            vasync.parallel({funcs: [
                function pkgs(next) {
                    addDevSamplePkgs(opts, next);
                },
                function imgs(next) {
                    addDevSampleImgs(opts, next);
                }
            ]}, nextFun);
        }
    ]}, cb);
}

function addDevSamplePkgs(opts, cb) {
    var papi = opts.sdcadm.papi;

    var samplePkgsPath = path.resolve(__dirname,
        '../../etc/sample-packages.json');
    var samplePkgs = JSON.parse(fs.readFileSync(samplePkgsPath, 'utf-8'));

    vasync.forEachPipeline({
        inputs: samplePkgs,
        func: function importPkg(pkgData, nextPkg) {
            papi.list({name: pkgData.name}, {}, function (err, pkgs) {
                if (err) {
                    nextPkg(new errors.SDCClientError(err, 'papi'));
                    return;
                } else if (pkgs.length !== 0) {
                    opts.progress('Already have package %s (%s).',
                        pkgData.name, pkgs[0].uuid);
                    nextPkg();
                    return;
                }

                papi.add(pkgData, function (addErr, pkg) {
                    if (addErr) {
                        nextPkg(new errors.SDCClientError(addErr, 'papi'));
                        return;
                    }
                    opts.progress('Added package %s (%s)', pkg.name, pkg.uuid);
                    nextPkg();
                });
            });
        }
    }, cb);
}

function addDevSampleImgs(opts, cb) {
    var imgNames = [
        'base-64-lts',
        /*
         * minimal-64-lts, ubuntu-16.04 and ubuntu-certified-16.04 images are
         * needed (among other things) by CloudAPI's volumes-automount.test.js.
         */
        'minimal-64-lts',
        'ubuntu-16.04',
        'ubuntu-certified-16.04'
    ];
    var imagesJo = opts.sdcadm.imagesJo;
    var imgapi = opts.sdcadm.imgapi;

    vasync.pipeline({arg: {}, funcs: [
        function getImgs(ctx, next) {
            ctx.imgs = [];
            vasync.forEachParallel({
                inputs: imgNames,
                func: function getImgLatestUuid(imgName, nextImg) {
                    imagesJo.listImages({name: imgName}, function (err, imgs) {
                        if (err) {
                            nextImg(new errors.SDCClientError(
                                err, 'imagesJo'));
                        } else if (imgs.length === 0) {
                            nextImg(new Error(format(
                                'no "%s" image found on images.smartos.org',
                                imgName)));
                        } else {
                            tabula.sortArrayOfObjects(imgs, ['published_at']);
                            ctx.imgs.push(imgs[imgs.length - 1]);
                            nextImg();
                        }
                    });
                }
            }, next);
        },
        function gatherWork(ctx, next) {
            // There are two types of "work" to be done:
            // 1. A list of images we need to import from images.smartos.org.
            ctx.imgsToDownload = [];
            // 2. A list of images that have already have been imported, but
            //    have `public=false`. This might happen if they were imported
            //    from updates.tritondatacenter.com, e.g. if as an origin image
            //    for a core Triton/Manta component. The intent of this sdcadm
            //    command is to get public images (e.g. for use via CloudAPI
            //    ListImages).
            ctx.imgsToMakePublic = [];

            vasync.forEachParallel({
                inputs: ctx.imgs,
                func: function checkImg(img, nextImg) {
                    imgapi.getImage(img.uuid, function getImgCb(err, localImg) {
                        if (!err) {
                            if (!localImg['public']) {
                                ctx.imgsToMakePublic.push(img);
                            } else {
                                opts.progress('Already have image %s (%s@%s).',
                                    img.uuid, img.name, img.version);
                            }
                            nextImg();
                        } else if (err.restCode === 'ResourceNotFound') {
                            ctx.imgsToDownload.push(img);
                            nextImg();
                        } else {
                            nextImg(new errors.SDCClientError(
                                err, 'imgapi'));
                        }
                    });
                }
            }, next);
        },
        function downloadImgs(ctx, next) {
            var proc = new DownloadImages({images: ctx.imgsToDownload});
            proc.execute({
                sdcadm: opts.sdcadm,
                log: opts.log,
                progress: opts.progress,
                source: imagesJo.url
            }, next);
        },
        function makeImgsPublic(ctx, next) {
            vasync.forEachParallel({
                inputs: ctx.imgsToMakePublic,
                func: function makeOneImgPublic(img, nextImg) {
                    imgapi.updateImage(img.uuid, {'public': true},
                        function updatedOneImg(err) {
                            if (!err) {
                                opts.progress('Made image %s (%s@%s) public.',
                                    img.uuid, img.name, img.version);
                            }
                            nextImg(err);
                        }
                    );
                }
            }, next);
        }
    ]}, cb);
}


// --- CLI

function do_dev_sample_data(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    addDevSampleData({
        sdcadm: this.sdcadm,
        log: this.log.child({postSetup: 'dev-sample-data'}, true),
        progress: this.top.progress
    }, cb);
}

do_dev_sample_data.help = (
    'Add sample data suitable for *development and testing*.\n' +
    '\n' +
    '- A set of "sample-*" packages are added for provisioning.\n' +
    '- The latest "base-64-lts" and "minimal-64-lts" images is installed.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} dev-sample-data\n'
);

do_dev_sample_data.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_dev_sample_data.logToFile = true;


// --- exports

module.exports = {
    do_dev_sample_data: do_dev_sample_data
};
