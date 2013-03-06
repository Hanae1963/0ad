/* Economy Manager
 * Deals with anything economic. Worker logic is in worker.js.
 */

var EconomyManager = function() {
	this.targetNumBuilders = Config.Economy.targetNumBuilders; // number of workers we want building stuff
	this.targetNumFields = 3;	// initial setting only.
	
	// Used by the QueueManager to determine future needs.
	this.baseNeed = {};
	this.baseNeed["food"] = 150;
	this.baseNeed["wood"] = 150;
	this.baseNeed["stone"] = 0;
	
	this.baseNeed["metal"] = 0;
	
	// see rePrioritize() for more info
	this.lastStatG = { "food" : 0, "wood" : 0, "stone" : 0, "metal" : 0};	// resource collecting stats: gathered
	this.lastStatU = { "food" : 0, "wood" : 0, "stone" : 0, "metal" : 0};	// resource collecting stats: used
	
	this.marketStartTime = Config.Economy.marketStartTime * 1000;
	this.dockStartTime =  Config.Economy.dockStartTime * 1000;
	this.farmsteadStartTime =  Config.Economy.farmsteadStartTime * 1000;
	this.techStartTime = Config.Economy.techStartTime * 1000;
	
	this.dockFailed = false;	// sanity check
	
	this.resourceMaps = {}; // Contains maps showing the density of wood, stone and metal
	this.CCResourceMaps = {}; // Contains maps showing the density of wood, stone and metal, optimized for CC placement.
	
	this.setCount = 0;  //stops villagers being reassigned to other resources too frequently, count a set number of 
	                    //turns before trying to reassign them.
	
	// this means we'll have about a big third of women, and thus we can maximize resource gathering rates.
	this.femaleRatio = Config.Economy.femaleRatio;

	this.farmingFields = false;
	
	this.dropsiteNumbers = {"wood": 1, "stone": 0.5, "metal": 0.5};
};
// More initialisation for stuff that needs the gameState
EconomyManager.prototype.init = function(gameState, events){
	this.targetNumWorkers = Math.max(Math.floor(gameState.getPopulationMax()*0.55), 1);
	
	// Athen's fastest Citizen soldier requires stone.
	if (gameState.civ() == "athen")
	{
		this.baseNeed["food"] = 140;
		this.baseNeed["wood"] = 100;
		this.baseNeed["stone"] = 50;
	}
	
	
	// initialize once all the resource maps.
	this.updateResourceMaps(gameState, events);
	this.updateResourceConcentrations(gameState,"food");
	this.updateResourceConcentrations(gameState,"wood");
	this.updateResourceConcentrations(gameState,"stone");
	this.updateResourceConcentrations(gameState,"metal");
	/*this.updateNearbyResources(gameState, "food");
	this.updateNearbyResources(gameState, "wood");
	this.updateNearbyResources(gameState, "stone");
	this.updateNearbyResources(gameState, "metal");
	*/
};

// okay, so here we'll create both females and male workers.
// We'll try to keep close to the "ratio" defined atop.
// qBot picks the best citizen soldier available: the cheapest and the fastest walker
// some civs such as Macedonia have 2 kinds of citizen soldiers: phalanx that are slow
// (speed:6) and peltasts that are very fast (speed: 11). Here, qBot will choose the peltast
// resulting in faster resource gathering.
// I'll also avoid creating citizen soldiers in the beginning because it's slower.
EconomyManager.prototype.trainMoreWorkers = function(gameState, queues) {
	// Count the workers in the world and in progress
	var numFemales = gameState.countEntitiesAndQueuedByType(gameState.applyCiv("units/{civ}_support_female_citizen"));
	numFemales += queues.villager.countTotalQueuedUnits();

	// counting the workers that aren't part of a plan
	var numWorkers = 0;
	gameState.getOwnEntities().forEach (function (ent) {
		if (ent.getMetadata(PlayerID, "role") == "worker" && ent.getMetadata(PlayerID, "plan") == undefined)
			numWorkers++;
	});
	var numInTraining = 0;
	gameState.getOwnTrainingFacilities().forEach(function(ent) {
	ent.trainingQueue().forEach(function(item) {
		if (item.metadata && item.metadata.role == "worker" && item.metadata.plan == undefined)
			numWorkers += item.count;
			numInTraining += item.count;
		});
	});
	var numQueued = queues.villager.countTotalQueuedUnits() + queues.citizenSoldier.countTotalQueuedUnits();
	var numTotal = numWorkers + numQueued;
	
	this.targetNumFields = numFemales/23;
	// ought to refine this.
	if ((gameState.ai.playedTurn+2) % 3 === 0) {
		this.dropsiteNumbers = {"wood": Math.ceil((numWorkers)/18)/2, "stone": Math.ceil((numWorkers)/30)/2, "metal": Math.ceil((numWorkers)/20)/2};
	}

	//debug (numTotal + "/" +this.targetNumWorkers + ", " +numFemales +"/" +numTotal);
	
	// If we have too few, train more
	// should plan enough to always have females…
	if (numTotal < this.targetNumWorkers && numQueued < 2 && (numQueued+numInTraining) < Math.min(Math.ceil(gameState.getTimeElapsed() / 60000)+ 4,15000)) {
		var template = gameState.applyCiv("units/{civ}_support_female_citizen");
		var size = Math.min(Math.ceil(gameState.getTimeElapsed() / 30000),5);
		if (numFemales/numTotal > this.femaleRatio && gameState.getTimeElapsed() > 60*1000) {
			template = this.findBestTrainableUnit(gameState, ["CitizenSoldier", "Infantry"], [ ["cost",1], ["speed",0.5]]);
			if (!template) {
				template = gameState.applyCiv("units/{civ}_support_female_citizen");
			}
		}
		if (template === gameState.applyCiv("units/{civ}_support_female_citizen"))
			queues.villager.addItem(new UnitTrainingPlan(gameState, template, { "role" : "worker" },size ));
		else
			queues.citizenSoldier.addItem(new UnitTrainingPlan(gameState, template, { "role" : "worker" },size ));
	}
};

// Tries to research any available tech
// Only one at once. Also does military tech (selection is completely random atm)
// TODO: Lots, lots, lots here.
EconomyManager.prototype.tryResearchTechs = function(gameState, queues) {
	if (queues.minorTech.totalLength() === 0)
	{
		var possibilities = gameState.findAvailableTech();
		if (possibilities.length === 0)
			return;
		// randomly pick one. No worries about pairs in that case.
		var p = Math.floor((Math.random()*possibilities.length));
		queues.minorTech.addItem(new ResearchPlan(gameState, possibilities[p][0]));
	}
}

// picks the best template based on parameters and classes
EconomyManager.prototype.findBestTrainableUnit = function(gameState, classes, parameters) {
	var units = gameState.findTrainableUnits(classes);

	if (units.length === 0)
		return undefined;

	units.sort(function(a, b) { //}) {
		var aDivParam = 0, bDivParam = 0;
		var aTopParam = 0, bTopParam = 0;
		for (i in parameters) {
			var param = parameters[i];
			
			if (param[0] == "base") {
				aTopParam = param[1];
				bTopParam = param[1];
			}
			if (param[0] == "strength") {
				aTopParam += getMaxStrength(a[1]) * param[1];
				bTopParam += getMaxStrength(b[1]) * param[1];
			}
			if (param[0] == "speed") {
				aTopParam += a[1].walkSpeed() * param[1];
				bTopParam += b[1].walkSpeed() * param[1];
			}
			
			if (param[0] == "cost") {
				aDivParam += a[1].costSum() * param[1];
				bDivParam += b[1].costSum() * param[1];
			}
		}
		return -(aTopParam/(aDivParam+1)) + (bTopParam/(bDivParam+1));
	});
	return units[0][0];
};



// Pick the resource which most needs another worker
EconomyManager.prototype.pickMostNeededResources = function(gameState) {
	var self = this;

	// Find what resource type we're most in need of
	if (!gameState.turnCache["gather-weights-calculated"]){
		this.gatherWeights = gameState.ai.queueManager.futureNeeds(gameState,this);
		gameState.turnCache["gather-weights-calculated"] = true;
	}
	
	var numGatherers = {};
	for (type in this.gatherWeights){
		numGatherers[type] = gameState.updatingCollection("workers-gathering-" + type, 
														  Filters.byMetadata(PlayerID, "gather-type", type)).length;//, gameState.getOwnEntitiesByRole("worker")).length;
	}
	//var totalWeight = numGatherers[a].length/gameState.getOwnEntitiesByRole("worker")).length;
	var types = Object.keys(this.gatherWeights);
	
	types.sort(function(a, b) {
		// Prefer fewer gatherers (divided by weight)
		var va = numGatherers[a] / (self.gatherWeights[a]+1);
		var vb = numGatherers[b] / (self.gatherWeights[b]+1);
		return va-vb;
	});
	return types;
};

EconomyManager.prototype.reassignRolelessUnits = function(gameState) {
	//TODO: Move this out of the economic section
	var roleless = gameState.getOwnEntitiesByRole(undefined);

	roleless.forEach(function(ent) {
		if (ent.hasClass("Worker")){
			ent.setMetadata(PlayerID, "role", "worker");
		}else if(ent.hasClass("CitizenSoldier") || ent.hasClass("Champion")){
			ent.setMetadata(PlayerID, "role", "soldier");
		}else{
			ent.setMetadata(PlayerID, "role", "unknown");
		}
	});
};

// If the numbers of workers on the resources is unbalanced then set some of workers to idle so 
// they can be reassigned by reassignIdleWorkers.
EconomyManager.prototype.setWorkersIdleByPriority = function(gameState){
	this.gatherWeights = gameState.ai.queueManager.futureNeeds(gameState,this);
	
	var numGatherers = {};
	var totalGatherers = 0;
	var totalWeight = 0;
	for ( var type in this.gatherWeights){
		numGatherers[type] = 0;
		totalWeight += this.gatherWeights[type];
	}

	gameState.getOwnEntitiesByRole("worker").forEach(function(ent) {
		if (ent.getMetadata(PlayerID, "subrole") === "gatherer"){
			numGatherers[ent.getMetadata(PlayerID, "gather-type")] += 1;
			totalGatherers += 1;
		}
	});

	for ( var type in this.gatherWeights){
		var allocation = Math.floor(totalGatherers * (this.gatherWeights[type]/totalWeight));
		if (allocation < numGatherers[type]){
			var numToTake = numGatherers[type] - allocation;
			gameState.getOwnEntitiesByRole("worker").forEach(function(ent) {
				if (ent.getMetadata(PlayerID, "subrole") === "gatherer" && ent.getMetadata(PlayerID, "gather-type") === type && numToTake > 0){
					ent.setMetadata(PlayerID, "subrole", "idle");
					ent.stopMoving();
					numToTake -= 1;
				}
			});
		}
	}
};

EconomyManager.prototype.reassignIdleWorkers = function(gameState) {
	
	var self = this;

	// Search for idle workers, and tell them to gather resources based on demand
	var filter = Filters.or(Filters.isIdle(), Filters.byMetadata(PlayerID, "subrole", "idle"));
	var idleWorkers = gameState.updatingCollection("idle-workers", filter, gameState.getOwnEntitiesByRole("worker"));
	
	if (idleWorkers.length) {
		var resourceSupplies;
		
		idleWorkers.forEach(function(ent) {
			// Check that the worker isn't garrisoned
			if (ent.position() === undefined){
				return;
			}
			
			var types = self.pickMostNeededResources(gameState);
			ent.setMetadata(PlayerID, "subrole", "gatherer");
			ent.setMetadata(PlayerID, "gather-type", types[0]);
		});
	}
};

EconomyManager.prototype.workersBySubrole = function(gameState, subrole) {
	var workers = gameState.getOwnEntitiesByRole("worker");
	return gameState.updatingCollection("subrole-" + subrole, Filters.byMetadata(PlayerID, "subrole", subrole), workers);
};

EconomyManager.prototype.assignToFoundations = function(gameState, noRepair) {
	// If we have some foundations, and we don't have enough
	// builder-workers,
	// try reassigning some other workers who are nearby
	
	// up to 2.5 buildings at once (that is 3, but one won't be complete).

	var foundations = gameState.getOwnFoundations().toEntityArray();
	var damagedBuildings = gameState.getOwnEntities().filter(function (ent) { if (ent.needsRepair() && ent.getMetadata(PlayerID, "plan") == undefined) { return true; } return false; }).toEntityArray();

	// Check if nothing to build
	if (!foundations.length && !damagedBuildings.length){
		return;
	}
	var workers = gameState.getOwnEntitiesByRole("worker");
	var builderWorkers = this.workersBySubrole(gameState, "builder");
	
	var addedWorkers = 0;
	
	for (i in foundations) {
		var target = foundations[i];
		if (target._template.BuildRestrictions.Category === "Field")
			continue; // we do not build fields
		var assigned = gameState.getOwnEntitiesByMetadata("target-foundation", target).length;
		if (assigned < this.targetNumBuilders) {
			if (builderWorkers.length + addedWorkers < this.targetNumBuilders*Math.min(3.0,gameState.getTimeElapsed()/60000)) {
				var nonBuilderWorkers = workers.filter(function(ent) { return (ent.getMetadata(PlayerID, "subrole") !== "builder" && ent.getMetadata(PlayerID, "gather-type") !== "food" && ent.position() !== undefined); });
				var nearestNonBuilders = null;
				if (target.hasClass("CivCentre"))
					nearestNonBuilders = nonBuilderWorkers.filterNearest(target.position(), this.targetNumBuilders*2.0 - assigned);
				else
					nearestNonBuilders = nonBuilderWorkers.filterNearest(target.position(), this.targetNumBuilders*2.0 - assigned);

				nearestNonBuilders.forEach(function(ent) {
					addedWorkers++;
					ent.setMetadata(PlayerID, "subrole", "builder");
					ent.setMetadata(PlayerID, "target-foundation", target);
				});
				if (this.targetNumBuilders - assigned - nearestNonBuilders.length > 0) {
					var nonBuilderWorkers = workers.filter(function(ent) { return (ent.getMetadata(PlayerID, "subrole") !== "builder" && ent.position() !== undefined); });
					var nearestNonBuilders = nonBuilderWorkers.filterNearest(target.position(), this.targetNumBuilders - assigned);
					nearestNonBuilders.forEach(function(ent) {
						addedWorkers++;
						ent.setMetadata(PlayerID, "subrole", "builder");
						ent.setMetadata(PlayerID, "target-foundation", target);
					});
				}
			}
		}
	}
	// don't repair if we're still under attack, unless it's like a vital (civcentre or wall) building that's getting destroyed.
	for (i in damagedBuildings) {
		var target = damagedBuildings[i];
		if (gameState.defcon() < 5) {
			if (target.healthLevel() > 0.5 || !target.hasClass("CivCentre") || !target.hasClass("StoneWall")) {
				continue;
			}
		} else if (noRepair && !target.hasClass("CivCentre"))
			continue;
		var assigned = gameState.getOwnEntitiesByMetadata("target-foundation", target).length;
		if (assigned < this.targetNumBuilders) {
			if (builderWorkers.length + addedWorkers < this.targetNumBuilders*2.5) {
				
				var nonBuilderWorkers = workers.filter(function(ent) { return (ent.getMetadata(PlayerID, "subrole") !== "builder" && ent.position() !== undefined); });
				if (gameState.defcon() < 5)
					nonBuilderWorkers = workers.filter(function(ent) { return (ent.getMetadata(PlayerID, "subrole") !== "builder" && ent.hasClass("Female") && ent.position() !== undefined); });
				var nearestNonBuilders = nonBuilderWorkers.filterNearest(target.position(), this.targetNumBuilders - assigned);
				
				nearestNonBuilders.forEach(function(ent) {
					addedWorkers++;
					ent.setMetadata(PlayerID, "subrole", "builder");
					ent.setMetadata(PlayerID, "target-foundation", target);
				});
			}
		}
	}
};

EconomyManager.prototype.buildMoreFields = function(gameState, queues) {
	if (this.farmingFields === true) {
		var numFarms = gameState.countEntitiesAndQueuedByType(gameState.applyCiv("structures/{civ}_field"));
		numFarms += queues.field.countTotalQueuedUnits();
	
		if (numFarms < this.targetNumFields + Math.floor(gameState.getTimeElapsed() / 750000))
			queues.field.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_field"));
	} else {
		var foodAmount = 0;
		gameState.getOwnDropsites("food").forEach( function (ent) { //}){
			if (ent.getMetadata(PlayerID, "resource-quantity-food") != undefined) {
				foodAmount += ent.getMetadata(PlayerID, "resource-quantity-food");
			} else {
				foodAmount = 450; // wait till we initialize
			}
		});
		if (foodAmount < 450)
			this.farmingFields = true;
	}
};

// If all the CC's are destroyed then build a new one
EconomyManager.prototype.buildNewCC= function(gameState, queues) {
	var numCCs = gameState.countEntitiesAndQueuedByType(gameState.applyCiv("structures/{civ}_civil_centre"));
	numCCs += queues.civilCentre.totalLength();

	// no use trying to lay foundations that will be destroyed
	if (gameState.defcon() > 2)
		for ( var i = numCCs; i < 1; i++) {
			gameState.ai.queueManager.clear();
			this.baseNeed["food"] = 0;
			this.baseNeed["wood"] = 50;
			this.baseNeed["stone"] = 50;
			this.baseNeed["metal"] = 50;
			queues.civilCentre.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_civil_centre"));
		}
	return (gameState.countEntitiesByType(gameState.applyCiv("structures/{civ}_civil_centre")) == 0 && gameState.currentPhase > 1);
};

// TODO: make it regularly update stone+metal mines
// creates and maintains a map of unused resource density
// this also takes dropsites into account.
// resources that are "part" of a dropsite are not counted.
EconomyManager.prototype.updateResourceMaps = function(gameState, events) {

	// By how much to divide the resource amount for plotting.
	var decreaseFactor = {'wood': 25.0, 'stone': 40.0, 'metal': 40.0, 'food': 20.0};
	// This is the maximum radius of the influence
	var dpRadius = 10;
	var radius = {'wood':10.0, 'stone': 24.0, 'metal': 24.0, 'food': 24.0};
		
	// smallRadius is the distance necessary to mark a resource as linked to a dropsite.
	var smallRadius = { 'food':80*80,'wood':60*60,'stone':70*70,'metal':70*70 };
	// bigRadius is the distance for a weak link (resources are considered when building other dropsites)
	// and their resource amount is divided by 3 when checking for dropsite resource level.
	var bigRadius = { 'food':140*140,'wood':140*140,'stone':140*140,'metal':140*140 };

	var self = this;
	
	for (var resource in radius){
		// if there is no resourceMap create one with an influence for everything with that resource
		if (! this.resourceMaps[resource]){
			this.resourceMaps[resource] = new Map(gameState);
			this.CCResourceMaps[resource] = new Map(gameState);
			// disabled as the game sends "create" events for all entities created at game start.
			/*var supplies = gameState.getResourceSupplies(resource);
			supplies.forEach(function(ent){
				if (!ent.position()){
					return;
				}
				var x = Math.round(ent.position()[0] / gameState.cellSize);
				var z = Math.round(ent.position()[1] / gameState.cellSize);
				var strength = Math.round(ent.resourceSupplyMax()/decreaseFactor[resource]);
				self.resourceMaps[resource].addInfluence(x, z, radius[resource], strength);
			});*/
		}
	}
	
	var needUpdate = {};
	
	// Look for destroy events and subtract the entities original influence from the resourceMap
	// also look for dropsite destruction and add the associated entities (along with unmarking them)
	for (var i in events) {
		var e = events[i];
		if (e.type === "Destroy") {
			
			if (e.msg.entityObj){
				var ent = e.msg.entityObj;
				if (ent && ent.position() && ent.resourceSupplyType() && ent.resourceSupplyType().generic !== "treasure") {
					if  (e.msg.metadata[PlayerID] && !e.msg.metadata[PlayerID]["linked-dropsite"]) {
						var resource = ent.resourceSupplyType().generic;
						var x = Math.round(ent.position()[0] / gameState.cellSize);
						var z = Math.round(ent.position()[1] / gameState.cellSize);
						var strength = Math.round(ent.resourceSupplyMax()/decreaseFactor[resource]);
						
						if (resource === "wood" || resource === "food")
						{
							this.resourceMaps[resource].addInfluence(x, z, 2, 5,'constant');
							this.resourceMaps[resource].addInfluence(x, z, 10.0, -strength,'constant');
							this.CCResourceMaps[resource].addInfluence(x, z, 15, -strength/2.0,'constant');
						} else if (resource === "stone" || resource === "metal")
						{
							this.resourceMaps[resource].addInfluence(x, z, 3, 50);
							this.resourceMaps[resource].addInfluence(x, z, 12.0, -strength/1.5);
							this.resourceMaps[resource].addInfluence(x, z, 12.0, -strength/2.0,'constant');
							this.CCResourceMaps[resource].addInfluence(x, z, 30, -strength,'constant');
						}
					}
				}
				if (ent && ent.owner() == PlayerID && ent.resourceDropsiteTypes() !== undefined) {
					var resources = ent.resourceDropsiteTypes();
					for (i in resources) {
						var resource = resources[i];
						// loop through all dropsites to see if the resources of his entity collection could
						// be taken over by another dropsite
						var dropsites = gameState.getOwnDropsites(resource);
						var metadata = e.msg.metadata[PlayerID];
						
						// can happen if it's destroyed before we've initialised it.
						if (!metadata)
							break;
						metadata["linked-resources-" + resource].filter( function (supply) { //}){
							var takenOver = false;
							dropsites.forEach( function (otherDropsite) { //}) {
								var distance = SquareVectorDistance(supply.position(), otherDropsite.position());
								if (supply.getMetadata(PlayerID, "linked-dropsite") == undefined || supply.getMetadata(PlayerID, "linked-dropsite-dist") > distance) {
									if (distance < bigRadius[resource]) {
										supply.setMetadata(PlayerID, "linked-dropsite", otherDropsite.id() );
										supply.setMetadata(PlayerID, "linked-dropsite-dist", +distance);
										if (distance < smallRadius[resource]) {
											takenOver = true;
											supply.setMetadata(PlayerID, "linked-dropsite-nearby", true );
										} else {
											supply.setMetadata(PlayerID, "linked-dropsite-nearby", false );
										}
									}
								}
							});
							if (!takenOver) {
								var x = Math.round(supply.position()[0] / gameState.cellSize);
								var z = Math.round(supply.position()[1] / gameState.cellSize);
								var strength = Math.round(supply.resourceSupplyMax()/decreaseFactor[resource]);
								if (resource === "wood" || resource === "food")
								{
									self.CCResourceMaps[resource].addInfluence(x, z, 15, strength/2.0,'constant');
									self.resourceMaps[resource].addInfluence(x, z, 10.0, strength,'constant');
									self.resourceMaps[resource].addInfluence(x, z, 2, -5,'constant');
								} else if (resource === "stone" || resource === "metal")
								{
									self.CCResourceMaps[resource].addInfluence(x, z, 30, strength,'constant');
									self.resourceMaps[resource].addInfluence(x, z, 12.0, strength/1.5);
									self.resourceMaps[resource].addInfluence(x, z, 12.0, strength/2.0,'constant');
									self.resourceMaps[resource].addInfluence(x, z, 3, -50);
								}
							}
						});
						needUpdate[resource] = true;
					}
				}
			}
		} else if (e.type === "Create") {
			if (e.msg.entity){
				var ent = gameState.getEntityById(e.msg.entity);
				if (ent && ent.position() && ent.resourceSupplyType() && ent.resourceSupplyType().generic !== "treasure"){
					var resource = ent.resourceSupplyType().generic;
					var addToMap = true;
					var dropsites = gameState.getOwnDropsites(resource);
					dropsites.forEach( function (otherDropsite) { //}) {
						var distance = SquareVectorDistance(ent.position(), otherDropsite.position());
						if (ent.getMetadata(PlayerID, "linked-dropsite") == undefined || ent.getMetadata(PlayerID, "linked-dropsite-dist") > distance) {
							if (distance < bigRadius[resource]) {
								if (distance < smallRadius[resource]) {
									if (ent.getMetadata(PlayerID, "linked-dropsite") == undefined)
										addToMap = false;
									ent.setMetadata(PlayerID, "linked-dropsite-nearby", true );
								} else {
									ent.setMetadata(PlayerID, "linked-dropsite-nearby", false );
								}
								ent.setMetadata(PlayerID, "linked-dropsite", otherDropsite.id() );
								ent.setMetadata(PlayerID, "linked-dropsite-dist", +distance);
							}
						}
					});
					if (addToMap) {
						var x = Math.round(ent.position()[0] / gameState.cellSize);
						var z = Math.round(ent.position()[1] / gameState.cellSize);
						var strength = Math.round(ent.resourceSupplyMax()/decreaseFactor[resource]);
						if (resource === "wood" || resource === "food")
						{
							this.CCResourceMaps[resource].addInfluence(x, z, 15, strength/2.0,'constant');
							this.resourceMaps[resource].addInfluence(x, z, 10.0, strength,'constant');
							this.resourceMaps[resource].addInfluence(x, z, 2, -5,'constant');
						} else if (resource === "stone" || resource === "metal")
						{
							this.CCResourceMaps[resource].addInfluence(x, z, 30, strength,'constant');
							this.resourceMaps[resource].addInfluence(x, z, 12.0, strength/1.5);
							this.resourceMaps[resource].addInfluence(x, z, 12.0, strength/2.0,'constant');
							this.resourceMaps[resource].addInfluence(x, z, 3, -50);
						}
					}
				} else if (ent && ent.position() && ent.resourceDropsiteTypes) {
					var resources = ent.resourceDropsiteTypes();
					for (i in resources) {
						var resource = resources[i];
						needUpdate[resource] = true;
					}
				}
			}
		}
	}
	
	for (i in needUpdate)
	{
		this.updateNearbyResources(gameState,i);
		this.updateResourceConcentrations(gameState,i);
	}
	
	/*if (gameState.ai.playedTurn % 20 === 1)
	{
		this.resourceMaps['wood'].dumpIm("s_tree_density_ " + gameState.getTimeElapsed() +".png", 1001);
		this.resourceMaps['stone'].dumpIm("stone_density_ " + gameState.getTimeElapsed() +".png", 1001);
		this.resourceMaps['metal'].dumpIm("s_metal_density_ " + gameState.getTimeElapsed() +".png", 1001);
		this.CCResourceMaps['wood'].dumpIm("CC_TREE " + gameState.getTimeElapsed() +".png", 1001);
		this.CCResourceMaps['stone'].dumpIm("CC_STONE " + gameState.getTimeElapsed() +".png", 1001);
		this.CCResourceMaps['metal'].dumpIm("CC_METAL " + gameState.getTimeElapsed() +".png", 1001);
	}*/
};

// Returns the position of the best place to build a new dropsite for the specified resource
EconomyManager.prototype.getBestResourceBuildSpot = function(gameState, resource){
	
	var friendlyTiles = new Map(gameState);

	friendlyTiles.madd(this.resourceMaps[resource],1.5);

	for (i in this.resourceMaps)
		if (i !== "food")
			friendlyTiles.addIfNotNull(this.resourceMaps[i]);
	
	//friendlyTiles.dumpIm(gameState.getTimeElapsed() + "_" + resource + "_density_fade_base.png", 1000);

	var territory = Map.createTerritoryMap(gameState);
	friendlyTiles.multiplyTerritory(gameState,territory,true);
		
	//friendlyTiles.dumpIm(gameState.getTimeElapsed() + "_" + resource + "_density_fade_caracas.png", 3000);

	//var resources = ["wood","stone","metal"];
	//for (i in resources)
	//	friendlyTiles.subtract(this.dropsiteMaps[resources[i]]);
	
	if (gameState.ai.distanceFromMeMap !== undefined)
		friendlyTiles.add(gameState.ai.distanceFromMeMap);
	
	//friendlyTiles.dumpIm(gameState.getTimeElapsed() + "_" + resource + "_density_fade_final.png", 1000);

	var obstructions = Map.createObstructionMap(gameState);
	obstructions.expandInfluences();
	
	var isCivilCenter = false;
	var best = friendlyTiles.findBestTile(2, obstructions);
	var bestIdx = best[0];
	
	if (best[1] <= 750 && gameState.currentPhase() >= 2)
	{
		// restart the search this time for a CC
		friendlyTiles = new Map(gameState);
		
		friendlyTiles.madd(this.CCResourceMaps[resource],1.8);
		for (i in this.CCResourceMaps)
			if (i !== "food")
				friendlyTiles.addIfNotNull(this.CCResourceMaps[i]);
		
		friendlyTiles.annulateTerritory(gameState,territory);
		
		if (gameState.ai.distanceFromMeMap !== undefined)
			friendlyTiles.add(gameState.ai.distanceFromMeMap);
		
		//friendlyTiles.dumpIm(gameState.getTimeElapsed() + "_" + resource + "_density_fade_final2_CC.png", 5000);
		
		best = friendlyTiles.findBestTile(4, obstructions);
		bestIdx = best[0];
	} else {
		//friendlyTiles.dumpIm(gameState.getTimeElapsed() + "_" + resource + "_density_fade_final2.png", 5000);
	}
	
	if (best[1] < 700)
	{
		// tell the dropsite builder we haven't found anything satisfactory.
		return [false, [-1,0]];
	}
	
	//warn ("Getting " + best[1] + " for " +resource);
	
	var x = ((bestIdx % friendlyTiles.width) + 0.5) * gameState.cellSize;
	var z = (Math.floor(bestIdx / friendlyTiles.width) + 0.5) * gameState.cellSize;

	if (territory.getOwner([x,z]) === 0) {
		isCivilCenter = true;
		bestIdx = friendlyTiles.findBestTile(4, obstructions)[0];
		x = ((bestIdx % friendlyTiles.width) + 0.5) * gameState.cellSize;
		z = (Math.floor(bestIdx / friendlyTiles.width) + 0.5) * gameState.cellSize;
	}
	return [isCivilCenter, [x,z]];
};
EconomyManager.prototype.updateResourceConcentrations = function(gameState, resource){
	var self = this;
	gameState.getOwnDropsites(resource).forEach(function(dropsite) { //}){
		var amount = 0;
		var amountFar = 0;
		// loop through the entity collections of linked-resources, if there is one.
		if (dropsite.getMetadata(PlayerID, "linked-resources-" + resource) == undefined)
			return;
		dropsite.getMetadata(PlayerID, "linked-resources-" + resource).forEach(function(supply){ //}){
			if (supply.getMetadata(PlayerID, "full") == true || supply.getMetadata(PlayerID, "inaccessible") == true)
				return;
			if (supply.getMetadata(PlayerID, "linked-dropsite-nearby") == true)
				amount += supply.resourceSupplyAmount();
			else
				amountFar += supply.resourceSupplyAmount();
			supply.setMetadata(PlayerID, "dp-update-value",supply.resourceSupplyAmount());
		});
		dropsite.setMetadata(PlayerID, "resource-quantity-" + resource, amount);
		dropsite.setMetadata(PlayerID, "resource-quantity-far-" + resource, amountFar);
		//debug (dropsite + " has " + amount + ", " + amountFar +" of " +resource);
	});
};

// Stores lists of nearby resources
// This is done only once per dropsite.
EconomyManager.prototype.updateNearbyResources = function(gameState,resource){
	var self = this;
	var resources = ["food", "wood", "stone", "metal"];
	var resourceSupplies;

	// By how much to divide the resource amount for plotting.
	var decreaseFactor = {'wood': 25.0, 'stone': 40.0, 'metal': 40.0, 'food': 20.0};
	// This is the maximum radius of the influence
	var radius = {'wood':10.0, 'stone': 24.0, 'metal': 24.0, 'food': 24.0};
	
	// smallRadius is the distance necessary to mark a resource as linked to a dropsite.
	var smallRadius = { 'food':80*80,'wood':60*60,'stone':70*70,'metal':70*70 };
	// bigRadius is the distance for a weak link (resources are considered when building other dropsites)
	// and their resource amount is divided by 3 when checking for dropsite resource level.
	var bigRadius = { 'food':140*140,'wood':140*140,'stone':140*140,'metal':140*140 };
	
	gameState.getOwnDropsites(resource).forEach(function(ent) { //}){
		
		if (ent.getMetadata(PlayerID, "nearby-resources-" + resource) === undefined){
			// let's defined the entity collections (by metadata)
			gameState.getResourceSupplies(resource).filter( function (supply) { //}){
				var distance = SquareVectorDistance(supply.position(), ent.position());
				// if we're close than the current linked-dropsite, or if it's not linked
				// TODO: change when actualy resource counting is implemented.
				
				if (supply.getMetadata(PlayerID, "linked-dropsite") == undefined || supply.getMetadata(PlayerID, "linked-dropsite-dist") > distance) {
					if (distance < bigRadius[resource]) {
						if (distance < smallRadius[resource]) {
							// it's new to the game, remove it from the resource maps
							if (supply.getMetadata(PlayerID, "linked-dropsite") == undefined || supply.getMetadata(PlayerID, "linked-dropsite-nearby") == false) {
								var x = Math.round(supply.position()[0] / gameState.cellSize);
								var z = Math.round(supply.position()[1] / gameState.cellSize);
								var strength = Math.round(supply.resourceSupplyMax()/decreaseFactor[resource]);
								if (resource === "wood" || resource === "food")
								{
									self.CCResourceMaps[resource].addInfluence(x, z, 15, -strength/2.0,'constant');
									self.resourceMaps[resource].addInfluence(x, z, 2, 5,'constant');
									self.resourceMaps[resource].addInfluence(x, z, 10.0, -strength,'constant');
								} else if (resource === "stone" || resource === "metal")
								{
									self.CCResourceMaps[resource].addInfluence(x, z, 30, -strength,'constant');
									self.resourceMaps[resource].addInfluence(x, z, 3, 50);
									self.resourceMaps[resource].addInfluence(x, z, 12.0, -strength/1.5);
									self.resourceMaps[resource].addInfluence(x, z, 12.0, -strength/2.0,'constant');
								}
							}
							supply.setMetadata(PlayerID, "linked-dropsite-nearby", true );
						} else {
							supply.setMetadata(PlayerID, "linked-dropsite-nearby", false );
						}
						supply.setMetadata(PlayerID, "linked-dropsite", ent.id() );
						supply.setMetadata(PlayerID, "linked-dropsite-dist", +distance);
					}
				}
			});
			// This one is both for the nearby and the linked
			var filter = Filters.byMetadata(PlayerID, "linked-dropsite", ent.id());
			var collection = gameState.getResourceSupplies(resource).filter(filter);
			collection.registerUpdates();
			ent.setMetadata(PlayerID, "linked-resources-" + resource, collection);
			
			filter = Filters.byMetadata(PlayerID, "linked-dropsite-nearby",true);
			var collection2 = collection.filter(filter);
			collection2.registerUpdates();
			ent.setMetadata(PlayerID, "nearby-resources-" + resource, collection2);
			
		}
		
		
		
		 /*// Make resources glow wildly
		if (resource == "food"){
			ent.getMetadata(PlayerID, "linked-resources-" + resource).forEach(function(ent){
				Engine.PostCommand({"type": "set-shading-color", "entities": [ent.id()], "rgb": [1,0,0]});
			});
			ent.getMetadata(PlayerID, "nearby-resources-" + resource).forEach(function(ent){
				Engine.PostCommand({"type": "set-shading-color", "entities": [ent.id()], "rgb": [10,0,0]});
			});
		}
		if (resource == "wood"){
			ent.getMetadata(PlayerID, "linked-resources-" + resource).forEach(function(ent){
			Engine.PostCommand({"type": "set-shading-color", "entities": [ent.id()], "rgb": [0,1,0]});
			});
			ent.getMetadata(PlayerID, "nearby-resources-" + resource).forEach(function(ent){
				Engine.PostCommand({"type": "set-shading-color", "entities": [ent.id()], "rgb": [0,10,0]});
			});
		}
		if (resource == "metal"){
			ent.getMetadata(PlayerID, "linked-resources-" + resource).forEach(function(ent){
				Engine.PostCommand({"type": "set-shading-color", "entities": [ent.id()], "rgb": [0,0,1]});
			});
			ent.getMetadata(PlayerID, "nearby-resources-" + resource).forEach(function(ent){
				Engine.PostCommand({"type": "set-shading-color", "entities": [ent.id()], "rgb": [0,0,10]});
			});
		}
		if (resource == "stone"){
			ent.getMetadata(PlayerID, "linked-resources-" + resource).forEach(function(ent){
				Engine.PostCommand({"type": "set-shading-color", "entities": [ent.id()], "rgb": [0,0.5,1]});
			});
			ent.getMetadata(PlayerID, "nearby-resources-" + resource).forEach(function(ent){
				Engine.PostCommand({"type": "set-shading-color", "entities": [ent.id()], "rgb": [0,5,10]});
			});
		}*/
	});
};

//return the number of resource dropsites with an acceptable amount of the resource nearby
EconomyManager.prototype.checkResourceConcentrations = function(gameState, resource){
	//TODO: make these values adaptive
	var requiredInfluence = {"wood": 2500, "stone": 600, "metal": 600};
	var count = 0;
	gameState.getOwnDropsites(resource).forEach(function(ent) { //}){
		if (ent.getMetadata(PlayerID, "resource-quantity-" + resource) == undefined || typeof(ent.getMetadata(PlayerID, "resource-quantity-" + resource)) !== "number") {
			count++;	// assume it's OK if we don't know.
			return;
		}
		var quantity = +ent.getMetadata(PlayerID, "resource-quantity-" + resource);
		var quantityFar = +ent.getMetadata(PlayerID, "resource-quantity-far-" + resource);

		if (quantity >= requiredInfluence[resource]) {
			count++;
		} else if (quantity + quantityFar >= requiredInfluence[resource]) {
			count += 0.5 + (quantity/requiredInfluence[resource])/2;
		} else {
			count += ((quantity + quantityFar)/requiredInfluence[resource])/2;
		}
	});
	return count;
};

EconomyManager.prototype.buildTemple = function(gameState, queues){
	if (gameState.currentPhase() >= 2 ) {
		if (queues.economicBuilding.countTotalQueuedUnits() === 0 &&
			gameState.countEntitiesAndQueuedByType(gameState.applyCiv("structures/{civ}_temple")) === 0){
			queues.economicBuilding.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_temple"));
		}
	}
};

EconomyManager.prototype.buildMarket = function(gameState, queues){
	if (gameState.getTimeElapsed() > this.marketStartTime && gameState.currentPhase() >= 2 ) {
		if (queues.economicBuilding.countTotalQueuedUnitsWithClass("BarterMarket") === 0 &&
			gameState.countEntitiesAndQueuedByType(gameState.applyCiv("structures/{civ}_market")) === 0){
			//only ever build one mill/CC/market at a time
			queues.economicBuilding.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_market"));
		}
	}
};

// Build a farmstead to go to town phase faster and prepare for research. Only really active on higher diff mode.
EconomyManager.prototype.buildFarmstead = function(gameState, queues){
	if (gameState.getTimeElapsed() > this.farmsteadStartTime) {
		if (queues.economicBuilding.countTotalQueuedUnitsWithClass("DropsiteFood") === 0 &&
			gameState.countEntitiesAndQueuedByType(gameState.applyCiv("structures/{civ}_farmstead")) === 0){
			//only ever build one mill/CC/market at a time
			queues.economicBuilding.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_farmstead"));
		}
	}
};

EconomyManager.prototype.buildDock = function(gameState, queues){
	if (!gameState.ai.waterMap || this.dockFailed)
		return;
	if (gameState.getTimeElapsed() > this.dockStartTime) {
		if (queues.economicBuilding.countTotalQueuedUnitsWithClass("NavalMarket") === 0 &&
			gameState.countEntitiesAndQueuedByType(gameState.applyCiv("structures/{civ}_dock")) === 0){
			if (gameState.civ() == "cart" && gameState.currentPhase() > 1)
				queues.economicBuilding.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_super_dock"));
			else if (gameState.civ() !== "cart")
				queues.economicBuilding.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_dock"));
		}
	}
};

// if qBot has resources it doesn't need, it'll try to barter it for resources it needs
// once per turn because the info doesn't update between a turn and I don't want to fix it.
// pretty efficient.
EconomyManager.prototype.tryBartering = function(gameState){
	var done = false;
	if (gameState.countEntitiesByType(gameState.applyCiv("structures/{civ}_market")) >= 1) {
		
		var needs = gameState.ai.queueManager.futureNeeds(gameState,false);
		var ress = gameState.ai.queueManager.getAvailableResources(gameState);
		
		for (sell in needs) {
			for (buy in needs) {
				if (!done && buy != sell && needs[sell] <= 0 && ress[sell] > 400) {	// if we don't need it and have a buffer
					if ( (ress[buy] < 400) || needs[buy] > 0) {	// if we need that other resource/ have too little of it
						var markets = gameState.getOwnEntitiesByType(gameState.applyCiv("structures/{civ}_market")).toEntityArray();
						markets[0].barter(buy,sell,100);
						//debug ("bartered " +sell +" for " + buy + ", value 100");
						done = true;
					}
				}
			}
		}
	}
};
// so this always try to build dropsites.
EconomyManager.prototype.buildDropsites = function(gameState, queues){
	if ( queues.dropsites.totalLength() === 0 && gameState.countFoundationsWithType(gameState.applyCiv("structures/{civ}_mill")) === 0 &&
		 gameState.countFoundationsWithType(gameState.applyCiv("structures/{civ}_civil_centre")) === 0){
			//only ever build one mill/CC/market at a time
		if (gameState.getTimeElapsed() > 30 * 1000){
			for (var resource in this.dropsiteNumbers){

				if (this.checkResourceConcentrations(gameState, resource) < this.dropsiteNumbers[resource]){
					var spot = this.getBestResourceBuildSpot(gameState, resource);
					if (spot[1][0] === -1)
						break;
					if (spot[0] === true){
						queues.dropsites.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_civil_centre", spot[1]));
					} else {
						queues.dropsites.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_mill", spot[1]));
					}
					break;
				}
			}
		}
	}
};
// build more houses if needed.
EconomyManager.prototype.buildMoreHouses = function(gameState, queues) {
	if (gameState.getTimeElapsed() < 25000)
		return;
	
	// temporary 'remaining population space' based check, need to do
	// predictive in future
	if (gameState.getPopulationLimit() - gameState.getPopulation() < 20
		&& gameState.getPopulationLimit() < gameState.getPopulationMax()) {
		
		var numConstructing = gameState.countEntitiesByType(gameState.applyCiv("foundation|structures/{civ}_house"));
		var numPlanned = queues.house.totalLength();
		
		var additional = Math.ceil((20 - (gameState.getPopulationLimit() - gameState.getPopulation())) / 10)
		- numConstructing - numPlanned;
		
		for ( var i = 0; i < additional; i++) {
			queues.house.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_house"));
		}
	}
};

// Change our priorities based on our gathering statistics.
EconomyManager.prototype.rePrioritize = function(gameState) {
	var statG = gameState.playerData.statistics.resourcesGathered;
	var statU = gameState.playerData.statistics.resourcesUsed;
	var resources = ["food", "wood", "stone", "metal"];
	for each (ress in resources)
	{
		var eff = (statG[ress]-this.lastStatG[ress]) / (statU[ress]-this.lastStatU[ress]);
		
		if ((statU[ress]-this.lastStatU[ress]) === 0)
			continue;
		
		if (eff < 0.6)
			this.baseNeed[ress] = Math.max(10, this.baseNeed[ress] + 10);
		else if (eff < 0.7)
			this.baseNeed[ress] = Math.max(10, this.baseNeed[ress] + 6);
		else if (eff < 0.8)
			this.baseNeed[ress] = Math.max(10, this.baseNeed[ress] + 4);
		else if (eff > 1.2)
			this.baseNeed[ress] = Math.max(10, this.baseNeed[ress] - 10 );
		else if (eff > 1.1)
			this.baseNeed[ress] = Math.max(10, this.baseNeed[ress] - 8 );
		else if (eff > 1.0)
			this.baseNeed[ress] = Math.max(10, this.baseNeed[ress] - 5 );
		else if (eff > 0.9)
			this.baseNeed[ress] = Math.max(10, this.baseNeed[ress] - 3 );
		//debug (ress + " Eff: " + eff);
	}

	//debug ("Stats ");
	//debug ("Food: " + this.baseNeed["food"]);
	//debug ("Wood: " + this.baseNeed["wood"]);
	//debug ("Stone: " + this.baseNeed["stone"]);
	//debug ("Metal: " + this.baseNeed["metal"]);
	
	this.lastStatG = statG;
	this.lastStatU = statU;
};

EconomyManager.prototype.update = function(gameState, queues, events) {
	Engine.ProfileStart("economy update");
	
	this.reassignRolelessUnits(gameState);
	
	// run a particular BO if we have no CC as this is highest priority
	if (this.buildNewCC(gameState,queues))
	{
		Engine.ProfileStart("Update Resource Maps and Concentrations");
		this.updateResourceMaps(gameState, events);
		
		if (gameState.ai.playedTurn % 2 === 0) {
			var resources = ["food", "wood", "stone", "metal"];
			this.updateNearbyResources(gameState, resources[(gameState.ai.playedTurn % 8)/2]);
		} else if (gameState.ai.playedTurn % 2 === 1) {
			var resources = ["food", "wood", "stone", "metal"];
			this.updateResourceConcentrations(gameState, resources[((gameState.ai.playedTurn+1) % 8)/2]);
		}
		Engine.ProfileStop();

		if (Config.difficulty !== 0)
			this.tryBartering(gameState);
		
		if (gameState.ai.playedTurn % 20 === 0){
			this.setWorkersIdleByPriority(gameState);
		} else {
			Engine.ProfileStart("Assign builders");
			this.assignToFoundations(gameState, false);
			Engine.ProfileStop();
			
			Engine.ProfileStart("Reassign Idle Workers");
			this.reassignIdleWorkers(gameState);
			Engine.ProfileStop();
		}
		
		// TODO: do this incrementally a la defence.js
		Engine.ProfileStart("Run Workers");
		gameState.getOwnEntitiesByRole("worker").forEach(function(ent){
			if (!ent.getMetadata(PlayerID, "worker-object")){
				ent.setMetadata(PlayerID, "worker-object", new Worker(ent));
			}
			ent.getMetadata(PlayerID, "worker-object").update(gameState);
		});
		// Gatherer count updates for non-workers
		var filter = Filters.and(Filters.not(Filters.byMetadata(PlayerID, "worker-object", undefined)),
								 Filters.not(Filters.byMetadata(PlayerID, "role", "worker")));
		gameState.updatingCollection("reassigned-workers", filter, gameState.getOwnEntities()).forEach(function(ent){
			ent.getMetadata(PlayerID, "worker-object").updateGathererCounts(gameState);
		});
		
		// Gatherer count updates for destroyed units
		for (var i in events) {
			var e = events[i];
			
			if (e.type === "Destroy") {
				if (e.msg.metadata && e.msg.metadata[PlayerID] && e.msg.metadata[PlayerID]["worker-object"]){
					e.msg.metadata[PlayerID]["worker-object"].updateGathererCounts(gameState, true);
					delete e.msg.metadata[PlayerID]["worker-object"];
				}
			}
		}
		Engine.ProfileStop();
		return;
	}

	// this function also deals with a few things that are number-of-workers related
	Engine.ProfileStart("Train workers and build farms, houses. Research techs.");
	this.trainMoreWorkers(gameState, queues);
	
	if ((gameState.ai.playedTurn+2) % 20 === 0 && gameState.getTimeElapsed() > this.techStartTime)
		this.tryResearchTechs(gameState,queues);
	
	if ((gameState.ai.playedTurn+1) % 3 === 0)
		this.buildMoreFields(gameState,queues);
	
	this.buildMoreHouses(gameState,queues);
	
	Engine.ProfileStop();

	//Later in the game we want to build stuff faster.
	if (gameState.getTimeElapsed() > 15*60*1000) {
		this.targetNumBuilders = Config.Economy.targetNumBuilders*4;
	}else if (gameState.getTimeElapsed() > 5*60*1000) {
		this.targetNumBuilders = Config.Economy.targetNumBuilders*2;
	} else {
		this.targetNumBuilders = Config.Economy.targetNumBuilders;
	}
	if (gameState.currentPhase() == 1)
		this.femaleRatio = Config.Economy.femaleRatio * 2.0;
	else
		this.femaleRatio = Config.Economy.femaleRatio;
	
	if (this.baseNeed["metal"] === 0 && gameState.getTimeElapsed() > 540*1000) {
		this.baseNeed["food"] = 140;
		this.baseNeed["wood"] = 100;
		this.baseNeed["stone"] = 50;
		this.baseNeed["metal"] = 80;
	}
	if (Config.difficulty === 2 && gameState.getTimeElapsed() > 540*1000 && gameState.ai.playedTurn % 60 === 10)
		this.rePrioritize(gameState);
		
	Engine.ProfileStart("Update Resource Maps and Concentrations");
	this.updateResourceMaps(gameState, events);
	if (gameState.ai.playedTurn % 2 === 0) {
		var resources = ["food", "wood", "stone", "metal"];
		this.updateNearbyResources(gameState, resources[(gameState.ai.playedTurn % 8)/2]);
	} else if (gameState.ai.playedTurn % 2 === 1) {
		var resources = ["food", "wood", "stone", "metal"];
		this.updateResourceConcentrations(gameState, resources[((gameState.ai.playedTurn+1) % 8)/2]);
	}
	Engine.ProfileStop();
	
	if (gameState.ai.playedTurn % 4 === 0) {
		Engine.ProfileStart("Build new Dropsites");
		this.buildDropsites(gameState, queues);
		Engine.ProfileStop();
	}
	if (Config.difficulty !== 0)
		this.tryBartering(gameState);
		
	this.buildFarmstead(gameState, queues);
	this.buildMarket(gameState, queues);
	if (gameState.countEntitiesAndQueuedByType(gameState.applyCiv("structures/{civ}_market")) === 1)
		this.buildTemple(gameState, queues);
	this.buildDock(gameState, queues);	// not if not a water map.

	if (gameState.ai.playedTurn % 20 === 0){
		this.setWorkersIdleByPriority(gameState);
	}
	
	Engine.ProfileStart("Assign builders");
	this.assignToFoundations(gameState);
	Engine.ProfileStop();

	Engine.ProfileStart("Reassign Idle Workers");
	this.reassignIdleWorkers(gameState);
	Engine.ProfileStop();
	
	// this is pretty slow, run it once in a while
	if (gameState.ai.playedTurn % 4 === 1) {
		Engine.ProfileStart("Swap Workers");
		var gathererGroups = {};
		gameState.getOwnEntitiesByRole("worker").forEach(function(ent){
			var key = uneval(ent.resourceGatherRates());
			if (!gathererGroups[key]){
				gathererGroups[key] = {"food": [], "wood": [], "metal": [], "stone": []};
			}
			if (ent.getMetadata(PlayerID, "gather-type") in gathererGroups[key]){
				gathererGroups[key][ent.getMetadata(PlayerID, "gather-type")].push(ent);
			}
		});
		for (var i in gathererGroups){
			for (var j in gathererGroups){
				var a = eval(i);
				var b = eval(j);
				if (a !== undefined && b !== undefined)
					if (a["food.grain"]/b["food.grain"] > a["wood.tree"]/b["wood.tree"] && gathererGroups[i]["wood"].length > 0
						&& gathererGroups[j]["food"].length > 0){
						for (var k = 0; k < Math.min(gathererGroups[i]["wood"].length, gathererGroups[j]["food"].length); k++){
							gathererGroups[i]["wood"][k].setMetadata(PlayerID, "gather-type", "food");
							gathererGroups[j]["food"][k].setMetadata(PlayerID, "gather-type", "wood");
						}
				}
			}
		}
		Engine.ProfileStop();
	}
	
	// TODO: do this incrementally a la defence.js
	Engine.ProfileStart("Run Workers");
	gameState.getOwnEntitiesByRole("worker").forEach(function(ent){
		if (!ent.getMetadata(PlayerID, "worker-object")){
			ent.setMetadata(PlayerID, "worker-object", new Worker(ent));
		}
		ent.getMetadata(PlayerID, "worker-object").update(gameState);
	});
	// Gatherer count updates for non-workers
	var filter = Filters.and(Filters.not(Filters.byMetadata(PlayerID, "worker-object", undefined)), 
	                         Filters.not(Filters.byMetadata(PlayerID, "role", "worker")));
	gameState.updatingCollection("reassigned-workers", filter, gameState.getOwnEntities()).forEach(function(ent){
		ent.getMetadata(PlayerID, "worker-object").updateGathererCounts(gameState);
	});
	
	// Gatherer count updates for destroyed units
	for (var i in events) {
		var e = events[i];

		if (e.type === "Destroy") {
			if (e.msg.metadata && e.msg.metadata[PlayerID] && e.msg.metadata[PlayerID]["worker-object"]){
				e.msg.metadata[PlayerID]["worker-object"].updateGathererCounts(gameState, true);
				delete e.msg.metadata[PlayerID]["worker-object"];
			}
		}
	}
	Engine.ProfileStop();

	Engine.ProfileStop();
};
