/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * Core SDCADM class.
 */

var format = require('util').format;
var fs = require('fs');
var p = console.log;
var path = require('path');

var assert = require('assert-plus');
var async = require('async');
var SAPI = require('sdc-clients').SAPI;

var common = require('./common');



//---- SDCADM class

/**
 * Create a SDCADM.
 *
 * @param options {Object}
 *      - log {Bunyan Logger}
 *      - profile {String} Optional. Name of profile to use. Defaults to
 *        'defaultProfile' in the config.
 */
function SDCADM(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalString(options.profile, 'options.profile');
    var self = this;

    this.config = common.loadConfigSync();

    //XXX Still need this?
    // Until we have a smartdc using restify with mcavage/node-restify#498
    // we need client_res and client_req serializers.
    //this.log = options.log.child({
    //    serializers: restify.bunyan.serializers
    //});
    this.log = options.log;

    this.__defineGetter__('sapi', function () {
        if (self._sapi === undefined) {
            self._sapi = new SAPI({
                url: self.config.sapi.url,
                log: self.log
            });
        }
        return self._cloudapi;
    });
}



//---- exports

module.exports = SDCADM;
