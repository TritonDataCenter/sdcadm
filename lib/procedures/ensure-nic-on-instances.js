/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

'use strict';

/*
 * Procedure to add an external, admin, or manta nic to every instance of a
 * given service. If some service instances already have the nic but some do
 * not, the nic will be added to the applicable instances.
 *
 * This procedure is currently used in multiple places: for example, to add
 * external nics to adminui and imgapi in
 * `sdcadm post-setup common-external-nics`, and to add a manta nic to grafana
 * in `sdcadm post-setup grafana`.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var Procedure = require('./procedure').Procedure;

/*
 * Constructor options:
 * - svcNames (Array of String): List of services whose instances the procedure
 *   will add nics to.
 * - nicTag (String): One of 'external', 'admin', or 'manta'. Specifies the
 *   type of nic to add.
 * - primary (Boolean): Optional; false by default. Specifies whether the new
 *   nic will be set as the primary nic. Note that, if an instance already has
 *   the nic specified by nicTag but the nic has the wrong 'primary' status,
 *   this procedure WILL NOT update that nic's 'primary' status -- that nic will
 *   be left alone.
 * - hardFail (Boolean): Optional; true by default. Controls the procedure's
 *   behavior when the specified network doesn't exist. If hardFail is true, the
 *   procedure will return an error. If hardFail is false, the procedure will do
 *   nothing and report success.
 * - volatile (Boolean): Optional; false by default. Caller should set this to
 *   true if we're running other procedures in `runProcs` that might create,
 *   delete, or modify services in 'svcNames' or instances of these services, or
 *   modify networks, in their execute() functions. Setting 'volatile' to true
 *   will defer the work of determining determining which nics to add from the
 *   prepare() function to the execute() function. Assuming the caller places
 *   the other relevant procedures before this procedure in the procedure list,
 *   this will ensure that all changes to instances have been made before this
 *   procedure's execute() function runs, allowing an accurate lookup of
 *   services, instances, and networks.
 */
function EnsureNicOnInstancesProcedure(opts) {
    assert.object(opts, 'opts');
    assert.arrayOfString(opts.svcNames, 'opts.svcNames');
    assert.string(opts.nicTag, 'opts.nicTag');
    assert.ok(common.validateNetType(opts.nicTag),
        'nicTag is invalid');
    assert.optionalBool(opts.primary, 'opts.primary');
    assert.optionalBool(opts.hardFail, 'opts.hardFail');
    assert.optionalBool(opts.volatile, 'opts.volatile');

    this.svcNames = opts.svcNames;
    this.nicTag = opts.nicTag;
    this.primary = opts.primary === undefined ? false : opts.primary;
    this.hardFail = opts.hardFail === undefined ? true : opts.hardFail;
    this.volatile = opts.volatile === undefined ? false : opts.volatile;

}
util.inherits(EnsureNicOnInstancesProcedure, Procedure);

/*
 * Gets all the instances of the specified services, checks the state of their
 * nics, and sorts the instances into two lists: those that require action and
 * those that do not. If no instances lack the nic specified by self.nicTag, we
 * have nothing to do, and indicate this fact to the calling function. If
 * 'volatile' is true, defers this work to the execute() function.
 *
 * Object properties set by this method, if 'volatile' is false, are:
 * - networkFound (Boolean): Whether or not the network specified by nicTag
 *   was found
 * - networkName (String): The name of the network, if the network was found
 * - instsWithNic (Array of Object): Instances that already have the desired nic
 * - instsWithoutNic (Array of Object): Instances that lack the desired nic
 */
EnsureNicOnInstancesProcedure.prototype.prepare =
    function prepare(opts, cb) {

    const self = this;

    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.object(opts.ui, 'opts.ui');

    assert.string(self.nicTag, 'self.nicTag');
    assert.ok(common.validateNetType(self.nicTag),
        'nicTag is invalid');
    assert.bool(self.hardFail, 'self.hardFail');
    assert.bool(self.volatile, 'self.volatile');

    const ui = opts.ui;

    /*
     * If the user has specified the 'volatile' flag, return early; defer all
     * work to the 'execute' function.
     */
    if (self.volatile) {
        cb(null, false);
        return;
    }

    self.doVolatileOperations(opts, function didVolatile(err, results) {
        if (err) {
            cb(err);
            return;
        }

        let nothingToDo;

        /*
         * If we found the network, we check to see if any of the instances lack
         * the relevant nic, and set nothingToDo accordingly.
         *
         * If we didn't find the network but we got here, then we know that
         * hardFail is false, and we indicate that there is nothing to do.
         */
        if (self.networkFound) {
            assert.arrayOfObject(self.instsWithoutNic);
            self.instsWithNic.forEach(function reportExistingNic(inst) {
                ui.info(sprintf('Instance %s (%s) already has %s nic',
                    inst.uuid, inst.params.alias, self.nicTag));
            });
            nothingToDo = self.instsWithoutNic.length === 0;
        } else {
            assert.equal(self.hardFail, false,
                'hardFail is true but network does not exist');
            ui.info('%s network not found; not adding nic', self.nicTag);
            nothingToDo = true;
        }

        cb(null, nothingToDo);
    });
};


EnsureNicOnInstancesProcedure.prototype.summarize =
    function summarize() {

    const self = this;

    assert.arrayOfString(self.svcNames, 'self.svcNames');
    assert.string(self.nicTag, 'self.nicTag');
    assert.ok(common.validateNetType(self.nicTag),
        'nicTag is invalid');

    let out = [];

    if (self.volatile) {
        /*
         * If the user has specified the 'volatile' flag, print a generic update
         * message -- we don't know what instances require action yet.
         */
        out.push(sprintf('Ensure all instances of %s service have %s nic, if ' +
            '%s network exists', self.svcNames.join(', '), self.nicTag,
            self.nicTag));
    } else {
        /*
         * Otherwise, verify that prepare has run already and print the specific
         * instances that require action.
         */
        assert.arrayOfObject(self.instsWithoutNic, 'self.instsWithoutNic');

        self.instsWithoutNic.forEach(function reportMissingNic(inst) {
            out.push(sprintf('add %s nic to instance %s (%s)', self.nicTag,
                inst.uuid, inst.params.alias));
        });
    }

    return out.join('\n');
};

/*
 * Adds the nic to the instances that lack it. If 'volatile' is true, this
 * method also does the work of figuring out which instances require action.
 *
 * Object properties set by this method, if 'volatile' is true, are:
 * - networkFound (Boolean): Whether or not the network specified by nicTag
 *   was found
 * - networkName (String): The name of the network, if the network was found
 * - instsWithNic (Array of Object): Instances that already have the desired nic
 * - instsWithoutNic (Array of Object): Instances that lack the desired nic
 *
 * If 'volatile' is false, these properties will have been set by prepare().
 */
EnsureNicOnInstancesProcedure.prototype.execute =
    function execute(opts, cb) {

    const self = this;

    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');

    assert.string(self.nicTag, 'self.nicTag');
    assert.ok(common.validateNetType(self.nicTag),
        'nicTag is invalid');
    assert.bool(self.primary, 'self.primary');

    const sdcadm = opts.sdcadm;
    const ui = opts.ui;

    vasync.pipeline({
        arg: {},
        funcs: [
            function doVolatileIfNecessary(_, next) {
                if (!self.volatile) {
                    next();
                    return;
                }
                self.doVolatileOperations(opts, next);
            }, function addNics(_, next) {
                /*
                 * However we got here, volatile or not, the fields set by
                 * doVolatileOperations should exist at this point.
                 */
                assert.bool(self.networkFound, 'self.networkFound');
                if (self.networkFound) {
                    assert.arrayOfObject(self.instsWithNic,
                        'self.instsWithNic');
                    assert.arrayOfObject(self.instsWithoutNic,
                        'self.instsWithoutNic');
                    assert.string(self.networkName);
                    sdcadm.addNics({
                        ui: ui,
                        insts: self.instsWithoutNic,
                        networkName: self.networkName,
                        primary: self.primary
                    }, next);
                } else {
                    /*
                     * If we didn't find the network but we got here, we know
                     * hardFail is false. Otherwise, we would have returned
                     * early with an error.
                     */
                    assert.equal(self.hardFail, false,
                        'hardFail is true but network does not exist');
                    /*
                     * volatile must be true if we're here. If volatile were
                     * false, we should have discovered that the network didn't
                     * exist in prepare() -- execute() should never have run.
                     */
                    assert.equal(self.volatile, true,
                        'volatile is false but missing network not detected ' +
                        'until execute()');

                    ui.info('%s network not found; not adding nic',
                        self.nicTag);
                    next();
                }
            }
        ]
    }, cb);

};

/*
 * This method groups the set of operations whose place of execution in the
 * runProcs sequence is determined by the presence of the 'volatile' flag. This
 * method should be called from prepare() or execute() rather than directly.
 *
 * Object properties set by this method are:
 * - networkFound (Boolean): Whether or not the network specified by nicTag
 *   was found
 * - networkName (String): The name of the network, if the network was found
 * - instsWithNic (Array of Object): Instances that already have the desired nic
 * - instsWithoutNic (Array of Object): Instances that lack the desired nic
 */
EnsureNicOnInstancesProcedure.prototype.doVolatileOperations =
    function doVolatileOperations(opts, cb) {

    const self = this;

    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.sdcadm.napi, 'opts.sdcadm.napi');

    assert.arrayOfString(self.svcNames, 'self.svcNames');
    assert.string(self.nicTag, 'self.nicTag');
    assert.ok(common.validateNetType(self.nicTag),
        'nicTag is invalid');
    assert.bool(self.hardFail, 'self.hardFail');

    const sdcadm = opts.sdcadm;
    const napi = opts.sdcadm.napi;

    let networkFound = false;
    let networkName;
    let instsWithNic;
    let instsWithoutNic;

    vasync.pipeline({
        funcs: [
            /*
             * We can't look up exact network names -- they could differ between
             * environments because of RAN.
             *
             * Thus, to check if the relevant network exists, we get all of the
             * networks and iterate through them, looking for a match.
             */
            function checkNetworkExists(_, next) {
                napi.listNetworks({
                    fabric: false
                }, function gotNetworks(err, networks) {
                    if (err) {
                        next(err);
                        return;
                    }
                    let isDesiredNetwork =
                        common.netTypeToNetFunc(self.nicTag);
                    networks.forEach(function checkNetwork(network) {
                        if (isDesiredNetwork(network)) {
                            /*
                             * We save the network name so we can use it later
                             * when adding a nic to each zone. We can't use
                             * nicTag to specify the network, because vmapi
                             * looks up networks by name or uuid, not nic tag,
                             * when adding nics. Network names are unique, so
                             * the name is sufficient to identify the network
                             */
                            networkFound = true;
                            networkName = network.name;
                        }
                    });
                    /*
                     * If the network doesn't exist and hardFail is true, fail
                     * here. Otherwise, continue. At the end of this function,
                     * we handle the case where hardFail is false and we didn't
                     * find the network.
                     */
                    if (!networkFound && self.hardFail) {
                        next(new errors.InternalError({
                            message: sprintf('No network found that matches ' +
                                'type "%s"', self.nicTag)
                        }));
                        return;
                    }
                    next();
                });
            },
            function getMissingNics(_, next) {
                if (networkFound) {
                    sdcadm.checkMissingNics({
                        svcNames: self.svcNames,
                        nicTag: self.nicTag
                    }, function gotMissingNics(err, nicLists) {
                        if (err) {
                            next(err);
                            return;
                        }
                        instsWithNic = nicLists.instsWithNic;
                        instsWithoutNic = nicLists.instsWithoutNic;
                        next();
                    });
                } else {
                    /*
                     * If we didn't find the network but we've still made it
                     * here, we know that hardFail must be false, and continue
                     * without attempting to look up the nics.
                     */
                    assert.equal(self.hardFail, false,
                        'hardFail is true but network does not exist');
                    next();
                }
            }
        ]
    }, function pipelineDone(err) {
        if (err) {
            cb(err);
            return;
        }
        self.networkFound = networkFound;
        self.networkName = networkName;
        self.instsWithNic = instsWithNic;
        self.instsWithoutNic = instsWithoutNic;
        cb();
    });
};

// --- exports

module.exports = {
    EnsureNicOnInstancesProcedure: EnsureNicOnInstancesProcedure
};

// vim: set softtabstop=4 shiftwidth=4:
