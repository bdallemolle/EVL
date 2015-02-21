/**				      Emerson PDU Monitor Data Server 
 * 
 * Collects SNMP data from the following hardward devices in the EVL:
 * - Emerson Liebert MPH Power Rack PDU Array 
 * 
 * Author: Bryan Dalle Molle 
 *         - Fall 2014
 *
 * Copyright (c) 2015, Bryan Dalle Molle
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *    - Redistributions of source code must retain the above copyright
 *      notice, this list of conditions and the following disclaimer.
 *    - Redistributions in binary form must reproduce the above copyright
 *      notice, this list of conditions and the following disclaimer in the
 *      documentation and/or other materials provided with the distribution.
 *    - Neither the name of Bryan Dalle Molle nor the
 *      names of its contributors may be used to endorse or promote products
 *      derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 **/

// Node modules
var snmp = require("net-snmp");
var http = require("http");
var express = require("express");
var app = express();

/* --------------------- SERVER DATA STORAGE SECTION ----------------------- */

function Receptacle() {					
    /** 
     *  Would be nice to have a current per plug 
	 *  (or something along those lines) for one-to-one
	 *  mapping of device power usage.  
	 * - inUse : whether or not power is drawn from
	 *           a particular receptacle
	 *			 *** appears to return 2 when state is ON?
	 */
	this.powStateOID = new Array(9);		// OID
};

function Branch() {						
	this.currentOID = new Array(3);			// OID
	// make array of 9 receptacles
	this.rc = [9];
	for (var i = 0; i < 9; i++) {
	    this.rc[i] = new Receptacle();
	}
};

function pdu() {
	this.totalInPowerOID = new Array(4); 	// OID
	this.accumEnergyOID = new Array(4);		// OID	
	// make array of 4 branch structures
	this.br = new Array(4);
	for (var i = 0; i < 4; i++) {
		this.br[i] = new Branch();
	}
};

/*** JSON OBJECT DECLARATIONS  ***/
var accumEnergyTotalObj = {};
accumEnergyTotalObj.totalEnergy = 0;
accumEnergyTotalObj.units = "Kilowatt Hours";
var totalInPowerObj = {};
totalInPowerObj.pdu = new Array(4);
totalInPowerObj.units = "Watts";
var accumEnergyObj = {};
accumEnergyObj.totalEnergy = 0;
accumEnergyObj.pdu = new Array(4);
accumEnergyObj.units = "Kilowatt Hours";
var currentObj = {};
currentObj.pdu = new2DArray(4, 3);
currentObj.units = "A AC";
currentObj.lineMap = ["L1-L2", "L2-L3", "L3-L1"];

/* ----------------- END SERVER DATA STORAGE SECTION ----------------------- */

var bOID = "1.3.6.1.4.1.476.1.42.3.8.";		// base OID digits for param OIDS
var PDU_PS = "30.20.1.";					// next OID digits for PDU.PS params
var PDU_RB = "40.20.1.";					// next OID digits for PDU.PS.RB params
var PDU_RCP = "50.20.1.";					// next OID digits for PDU.PS.RCP
var session = snmp.createSession ("192.168.1.103", "LiebertEM");
var PDU = new pdu();						// initialize PDU array

// init loop
for (var i = 0; i < 4; i++) {
	// init "total input power" and "accumulated energy"
	PDU.totalInPowerOID[i] = bOID+PDU_PS+"65."+(i+1)+".1";
	PDU.accumEnergyOID[i] = bOID+PDU_PS+"50."+(i+1)+".1";
	for (var j = 0; j < 3; j++) {
		// init "current per branch"
		PDU.br[i].currentOID[j] = bOID+PDU_RB+"130."+(i+1)+"."+(j+1);
		for (var k = 0; k < 9; k++) {
			// init "power state"
		    PDU.br[i].rc[j].powStateOID[k] = bOID+PDU_RCP+"95."+(i+1)+"."+(j+1)+"."+(k+1);
		}
	}
}

// queue...
var gTicks = 0;									// global tick counter
var TICK_SIZE = 10;								// 
var currentQueue = new Array(TICK_SIZE);		// circular queue for current
// init queue
for (var i = 0; i < TICK_SIZE; i++) {
	// init each slice
    currentQueue[i] = new Array(4);
    for (var j = 0; j < 4; j++) {
		// init each PDU
		currentQueue[i][j] = new Array(3);
		for (var k = 0; k < 3; k++) {
			// init each current value
			currentQueue[i][j][k] = 0;
		}
	}
}


myTimer();										// INITIAL TIMER CALL	
setInterval(function(){myTimer()}, 1000); 		// BEGIN TIMED SNMP REQUEST	
var server = app.listen(8888, function() {  	// CREATE SERVER
	var host = server.address().address;
	var port = server.address().port;
	console.log("Power monitor listening to http://%s:%s", host, port);
})

/* ------------------------------------------------------------------------- */

/** myTimer() function
 *  Upon timer, this function gets called to get data via SNMP
 *  messages
 */
function myTimer() {
	// get fields
	getOIDstr(PDU.totalInPowerOID, 
	          totalInPowerObj.pdu, 
	          function(dest, storage) 
			  {myCopyBack(dest, storage)});
			  
	getOIDstr(PDU.accumEnergyOID, 
			  accumEnergyObj.pdu, 
	          function(dest, storage) 
			  {myCopyBack(dest, storage)});
			  
	// get ALL branches here
	for (var i = 0; i < 4; i++) {
		getOIDstr(PDU.br[i].currentOID,
				  currentObj.pdu[i],
		          function(dest, storage) 
				  {myCopyBack(dest, storage)});	
    }
	
	// get all receptacle data
	/** This keeps timing out after 18 receptacles...
	 *  ... some bug I have not figured out yet...
	 *  for (var i = 0; i < 4; i++) {
	 *      for (var j = 0; j < 3; j++) {
		    for (var k = 0; k < 9; k++) {
				console.log("trying " + PDU.br[i].rc[j].powStateOID[k]);
				getOIDstr(PDU.br[i].rc[j].powStateOID, PDU.br[i].rc[j].powState,
				          function(dest, storage) {myCopyBack(dest, storage)});
			}	
		}
    }
	*/
	
	// populate appropriate JSON objects
	var total = 0;
	for (var i = 0; i < 4; i++) {
	    total += accumEnergyObj.pdu[i];
	}
	accumEnergyTotalObj.totalEnergy = total;
	accumEnergyObj.totalEnergy = total;
	
	// update circular queue storage
	updateQueue();
	// update timer
	gTicks++;
}

/* updateQueue() function
 * updates the circular queue 
 */
function updateQueue() {
	console.log("Updating queue");
	if (gTicks >= TICK_SIZE) gTicks = 0;
	for (var i = 0; i < 4; i++ ) {
		for (var j = 0; j < 3; j++) {
			if (currentObj.pdu[i][j] != null) {
				// currentQueue[gTicks][i][j] = PDU.br[i].current[j];
				currentQueue[gTicks][i][j] = currentObj.pdu[i][j];
			}
		}
	}
}

/* getOIDstr() function
 * Given an OID, a destination array, and a copyback function,
 * get the data at specified OID address via SNMP and store it
 * in the destination array with the copyback function
 */
function getOIDstr(oidStr, destArr, copyBack) {
	session.get(oidStr, function (error, varbinds) {
		if (error) {
			console.error(error.toString());
		} else {
			var storageArray = [];
			for (var i = 0; i < varbinds.length; i++) {
				if (varbinds[i].type != snmp.ErrorStatus.NoSuchObject &&
					varbinds[i].type != snmp.ErrorStatus.NoSuchInstance &&
					varbinds[i].type != snmp.ErrorStatus.EndOfMibView) {
					storageArray[i] = varbinds[i].value;
				} else {
					console.error(snmp.ObjectType[varbinds[0].type]+": "+varbinds[0].oid);
				}
			}
			copyBack(destArr, storageArray);
		}
	});
}

/* ------------------------------------------------------------------------- */

/** 
 *  Route options
 *	URL == solgae.evl.uic.edu:8888/
 *		- "/" : prints a hello message
 *		- "/totalAccumEnergy" : provides the sum of every PDU's 
 *		  						array total accumulated
 *		  						energy in kilowatt hours 
 * 		- "/accumEnergy" : 	    provides the accumulated energy value
 *								for each PDU rack  
 * 		- "/totalInEnergy" : 	provides the total input energy
 * 								for each PDU rack 
 * 		- "/current" : 	    	provides the current for each PDU rack 
 * 		- "/currentQueue" : 	provides an unformatted circular queue
 * 								of the current at 1-second slices of time 
 */ 
app.get("/", function(request, response) {
	// display main page information
	response.send("Solgae Power Info server reached!");
});

/* JSON OBJECT ROUTES */
app.get("/totalAccumEnergy", function(request, response) {
	// provide total energy accumulated json object
	response.header("Access-Control-Allow-Origin", "*");
	response.send(accumEnergyTotalObj);
});

app.get("/accumEnergy", function(request, response) {
	// provide accumulated energy object
	response.header("Access-Control-Allow-Origin", "*");
    response.send(accumEnergyObj);
});

app.get("/totalInEnergy", function(request, response) {
	// total input energy json object
	response.header("Access-Control-Allow-Origin", "*");
    response.send(totalInPowerObj);
});

app.get("/current", function(request, response) {
	// total input energy json object
	response.header("Access-Control-Allow-Origin", "*");
    response.send(currentObj);
});

app.get("/currentQueue", function(request, response) {
	// display an unformated current queue
	response.header("Access-Control-Allow-Origin", "*");
	response.send(currentQueue);
});

/* ------------------------------------------------------------------------- */

/* copyBack() function
 * Utility array copy callback function. Used when snmp-get calls
 * return and need to store data in global data structures
 */
function myCopyBack(a, b) {
	// copy to data structure
	for (var i = 0; i < a.length; i++) {
		a[i] = b[i];
	}
	// display for testing
	console.log("SNMP DATA COLLECTED");
	for (var i = 0; i < a.length; i++) {
		console.log("RETURN[" + i + "]: " + a[i] + " Units");
	}
}

/* new2DArray(number of rows, number of columns)
 * Utility 2D array creater...
 */
function new2DArray(rows, cols) {
  var a = [];
  for (var i = 0; i < rows; i++) {
     a[i] = new Array(cols);
  }
  return a;
}