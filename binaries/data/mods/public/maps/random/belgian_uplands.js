Engine.LoadLibrary("rmgen");
Engine.LoadLibrary("rmgen-common");
Engine.LoadLibrary("heightmap");

const tPrimary = ["temp_grass", "temp_grass_b", "temp_grass_c", "temp_grass_d",
	"temp_grass_long_b", "temp_grass_clovers_2", "temp_grass_mossy", "temp_grass_plants"];

const heightLand = 0;
const g_Map = new RandomMap(heightLand, tPrimary);
const numPlayers = getNumPlayers();
const mapSize = g_Map.getSize();
const mapCenter = g_Map.getCenter();

// Set target min and max height depending on map size to make average stepness the same on all map sizes
const heightRange = {"min": MIN_HEIGHT * mapSize / 8192, "max": MAX_HEIGHT * mapSize / 8192};

// Since erosion is not predictable, actual water coverage can differ much with the same value
const averageWaterCoverage = scaleByMapSize(1/5, 1/3);

const heightSeaGround = -MIN_HEIGHT + heightRange.min + averageWaterCoverage * (heightRange.max - heightRange.min);
const heightSeaGroundAdjusted = heightSeaGround + MIN_HEIGHT;
setWaterHeight(heightSeaGround);

const textueByHeight = [];

// Deep water
textueByHeight.push({"upperHeightLimit": heightRange.min + 1/3 * (heightSeaGroundAdjusted - heightRange.min), "terrain": "temp_sea_rocks"});

// Medium deep water (with fish)
var terrains = ["temp_sea_weed"];
terrains = terrains.concat(terrains, terrains, terrains, terrains);
terrains = terrains.concat(terrains, terrains, terrains, terrains);
terrains.push("temp_sea_weed|gaia/fish/generic");
textueByHeight.push({"upperHeightLimit": heightRange.min + 2/3 * (heightSeaGroundAdjusted - heightRange.min), "terrain": terrains});

// Flat Water
textueByHeight.push({"upperHeightLimit": heightRange.min + 3/3 * (heightSeaGroundAdjusted - heightRange.min), "terrain": "temp_mud_a"});

// Water surroundings/bog (with stone/metal some rabits and bushes)
var terrains = ["temp_plants_bog", "temp_plants_bog_aut", "temp_dirt_gravel_plants", "temp_grass_d"];
terrains = terrains.concat(terrains, terrains, terrains, terrains, terrains);
terrains = ["temp_plants_bog|gaia/tree/bush_temperate"].concat(terrains, terrains);
terrains = ["temp_dirt_gravel_plants|gaia/ore/temperate_small", "temp_dirt_gravel_plants|gaia/rock/temperate_small", "temp_plants_bog|gaia/fauna_rabbit"].concat(terrains, terrains);
terrains = ["temp_plants_bog_aut|gaia/tree/dead"].concat(terrains, terrains);
textueByHeight.push({"upperHeightLimit": heightSeaGroundAdjusted + 1/6 * (heightRange.max - heightSeaGroundAdjusted), "terrain": terrains});

// Juicy grass near bog
textueByHeight.push({"upperHeightLimit": heightSeaGroundAdjusted + 2/6 * (heightRange.max - heightSeaGroundAdjusted),
	"terrain": ["temp_grass", "temp_grass_d", "temp_grass_long_b", "temp_grass_plants"]});

// Medium level grass
// const testActor = "actor|geology/decal_stone_medit_a.xml";
textueByHeight.push({"upperHeightLimit": heightSeaGroundAdjusted + 3/6 * (heightRange.max - heightSeaGroundAdjusted),
	"terrain": ["temp_grass", "temp_grass_b", "temp_grass_c", "temp_grass_mossy"]});

// Long grass near forest border
textueByHeight.push({"upperHeightLimit": heightSeaGroundAdjusted + 4/6 * (heightRange.max - heightSeaGroundAdjusted),
	"terrain": ["temp_grass", "temp_grass_b", "temp_grass_c", "temp_grass_d", "temp_grass_long_b", "temp_grass_clovers_2", "temp_grass_mossy", "temp_grass_plants"]});

// Forest border (With wood/food plants/deer/rabits)
var terrains = ["temp_grass_plants|gaia/tree/euro_beech", "temp_grass_mossy|gaia/tree/poplar", "temp_grass_mossy|gaia/tree/poplar_lombardy",
	"temp_grass_long|gaia/tree/bush_temperate", "temp_mud_plants|gaia/tree/bush_temperate", "temp_mud_plants|gaia/tree/bush_badlands",
	"temp_grass_long|gaia/fruit/apple", "temp_grass_clovers|gaia/fruit/berry_01", "temp_grass_clovers_2|gaia/fruit/grapes",
	"temp_grass_plants|gaia/fauna_deer", "temp_grass_long_b|gaia/fauna_rabbit"];

const numTerrains = terrains.length;
for (let i = 0; i < numTerrains; i++)
	terrains.push("temp_grass_plants");
textueByHeight.push({"upperHeightLimit": heightSeaGroundAdjusted + 5/6 * (heightRange.max - heightSeaGroundAdjusted), "terrain": terrains});

// Unpassable woods
textueByHeight.push({"upperHeightLimit": heightSeaGroundAdjusted + 6/6 * (heightRange.max - heightSeaGroundAdjusted),
	"terrain": ["temp_grass_mossy|gaia/tree/oak", "temp_forestfloor_pine|gaia/tree/pine",
	"temp_grass_mossy|gaia/tree/oak", "temp_forestfloor_pine|gaia/tree/pine",
	"temp_mud_plants|gaia/tree/dead", "temp_plants_bog|gaia/tree/oak_large",
	"temp_dirt_gravel_plants|gaia/tree/aleppo_pine", "temp_forestfloor_autumn|gaia/tree/carob"]});

Engine.SetProgress(5);

const lowerHeightLimit = textueByHeight[3].upperHeightLimit;
const upperHeightLimit = textueByHeight[6].upperHeightLimit;

let playerPosition;
let playerIDs;

while (true)
{
	g_Map.log("Randomizing heightmap");
	createArea(
		new MapBoundsPlacer(),
		new RandomElevationPainter(heightRange.min, heightRange.max));

	 // More cycles yield bigger structures
	g_Map.log("Smoothing map");
	createArea(
		new MapBoundsPlacer(),
		new SmoothingPainter(2, 1, 20));

	g_Map.log("Rescaling map");
	rescaleHeightmap(heightRange.min, heightRange.max, g_Map.height);

	g_Map.log("Mark valid heightrange for player starting positions");
	const tHeightRange = g_Map.createTileClass();
	const area = createArea(
		new DiskPlacer(fractionToTiles(0.5) - MAP_BORDER_WIDTH, mapCenter),
		new TileClassPainter(tHeightRange),
		new HeightConstraint(lowerHeightLimit, upperHeightLimit));

	const players = area && playerPlacementRandom(sortAllPlayers(), stayClasses(tHeightRange, 15), true);
	if (players)
	{
		[playerIDs, playerPosition] = players;
		break;
	}

	g_Map.log("Too few starting locations");
}
Engine.SetProgress(60);

g_Map.log("Painting terrain by height and add props");
let propDensity = 1; // 1 means as determined in the loop, less for large maps as set below
if (mapSize > 500)
	propDensity = 1/4;
else if (mapSize > 400)
	propDensity = 3/4;

for (let x = 0; x < mapSize; ++x)
	for (let y = 0; y < mapSize; ++y)
	{
		const position = new Vector2D(x, y);
		if (!g_Map.validHeight(position))
			continue;

		let textureMinHeight = heightRange.min;
		for (let i = 0; i < textueByHeight.length; i++)
		{
			if (g_Map.getHeight(position) >= textureMinHeight && g_Map.getHeight(position) <= textueByHeight[i].upperHeightLimit)
			{
				createTerrain(textueByHeight[i].terrain).place(position);

				let template;

				if (i == 0) // ...deep water
				{
					if (randBool(propDensity / 100))
						template = "actor|props/flora/pond_lillies_large.xml";
					else if (randBool(propDensity / 40))
						template = "actor|props/flora/water_lillies.xml";
				}
				if (i == 1) // ...medium water (with fish)
				{
					if (randBool(propDensity / 200))
						template = "actor|props/flora/pond_lillies_large.xml";
					else if (randBool(propDensity / 100))
						template = "actor|props/flora/water_lillies.xml";
				}
				if (i == 2) // ...low water/mud
				{
					if (randBool(propDensity / 200))
						template = "actor|props/flora/water_log.xml";
					else if (randBool(propDensity / 100))
						template = "actor|props/flora/water_lillies.xml";
					else if (randBool(propDensity / 40))
						template = "actor|geology/highland_c.xml";
					else if (randBool(propDensity / 20))
						template = "actor|props/flora/reeds_pond_lush_b.xml";
					else if (randBool(propDensity / 10))
						template = "actor|props/flora/reeds_pond_lush_a.xml";
				}
				if (i == 3) // ...water suroundings/bog
				{
					if (randBool(propDensity / 200))
						template = "actor|props/flora/water_log.xml";
					else if (randBool(propDensity / 100))
						template = "actor|geology/highland_c.xml";
					else if (randBool(propDensity / 40))
						template = "actor|props/flora/reeds_pond_lush_a.xml";
				}
				if (i == 4) // ...low height grass
				{
					if (randBool(propDensity / 800))
						template = "actor|props/flora/grass_field_flowering_tall.xml";
					else if (randBool(propDensity / 400))
						template = "actor|geology/gray_rock1.xml";
					else if (randBool(propDensity / 200))
						template = "actor|props/flora/bush_tempe_sm_lush.xml";
					else if (randBool(propDensity / 100))
						template = "actor|props/flora/bush_tempe_b.xml";
					else if (randBool(propDensity / 40))
						template = "actor|props/flora/grass_soft_small_tall.xml";
				}
				if (i == 5) // ...medium height grass
				{
					if (randBool(propDensity / 800))
						template = "actor|geology/decal_stone_medit_a.xml";
					else if (randBool(propDensity / 400))
						template = "actor|props/flora/decals_flowers_daisies.xml";
					else if (randBool(propDensity / 200))
						template = "actor|props/flora/bush_tempe_underbrush.xml";
					else if (randBool(propDensity / 100))
						template = "actor|props/flora/grass_soft_small_tall.xml";
					else if (randBool(propDensity / 40))
						template = "actor|props/flora/grass_temp_field.xml";
				}
				if (i == 6) // ...high height grass
				{
					if (randBool(propDensity / 400))
						template = "actor|geology/stone_granite_boulder.xml";
					else if (randBool(propDensity / 200))
						template = "actor|props/flora/foliagebush.xml";
					else if (randBool(propDensity / 100))
						template = "actor|props/flora/bush_tempe_underbrush.xml";
					else if (randBool(propDensity / 40))
						template = "actor|props/flora/grass_soft_small_tall.xml";
					else if (randBool(propDensity / 20))
						template = "actor|props/flora/ferns.xml";
				}
				if (i == 7) // ...forest border (with wood/food plants/deer/rabits)
				{
					if (randBool(propDensity / 400))
						template = "actor|geology/highland_c.xml";
					else if (randBool(propDensity / 200))
						template = "actor|props/flora/bush_tempe_a.xml";
					else if (randBool(propDensity / 100))
						template = "actor|props/flora/ferns.xml";
					else if (randBool(propDensity / 40))
						template = "actor|props/flora/grass_soft_tuft_a.xml";
				}
				if (i == 8) // ...woods
				{
					if (randBool(propDensity / 200))
						template = "actor|geology/highland2_moss.xml";
					else if (randBool(propDensity / 100))
						template = "actor|props/flora/grass_soft_tuft_a.xml";
					else if (randBool(propDensity / 40))
						template = "actor|props/flora/ferns.xml";
				}

				if (template)
					g_Map.placeEntityAnywhere(template, 0, position, randomAngle());

				break;
			}
			else
				textureMinHeight = textueByHeight[i].upperHeightLimit;
		}
	}

Engine.SetProgress(90);

if (isNomad())
	placePlayersNomad(g_Map.createTileClass(), new HeightConstraint(lowerHeightLimit, upperHeightLimit));
else
{
	g_Map.log("Placing players and starting resources");

	const resourceDistance = 8;
	const resourceSpacing = 1;
	const resourceCount = 4;

	for (let i = 0; i < numPlayers; ++i)
	{
		placeCivDefaultStartingEntities(playerPosition[i], playerIDs[i], false);

		for (let j = 1; j <= 4; ++j)
		{
			const uAngle = BUILDING_ORIENTATION - Math.PI * (2-j) / 2;
			for (let k = 0; k < resourceCount; ++k)
			{
				const pos = Vector2D.sum([
					playerPosition[i],
					new Vector2D(resourceDistance, 0).rotate(-uAngle),
					new Vector2D(k * resourceSpacing, 0).rotate(-uAngle - Math.PI/2),
					new Vector2D(-0.75 * resourceSpacing * Math.floor(resourceCount / 2), 0).rotate(-uAngle - Math.PI/2)
				]);

				g_Map.placeEntityPassable(j % 2 ? "gaia/tree/cypress" : "gaia/fruit/berry_01", 0, pos, randomAngle());
			}
		}
	}
}

g_Map.ExportMap();
