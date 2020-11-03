window.L = lalolib;

const Columns = {
    DRAW: { name: 'draw', index: 0 },
    DEM_EV: { name: 'dem_ev', index: 1 },
    NATL_POP_VOTE: { name: 'natl_pop_vote', index: 2 },
    STATES_START: { name: undefined, index: 3 },
};

const DEFAULT_SAMPLES = 10000;
const DEFAULT_AUTORUN = true;

const RAW_STATE_EVS = {"AL":9,"AK":3,"AZ":11,"AR":6,"CA":55,"CO":9,"CT":7,"DC":3,"DE":3,"FL":29,"GA":16,"HI":4,"ID":4,"IL":20,"IN":11,"IA":6,"KS":6,"KY":8,"LA":8,"ME":2,"ME1":1,"ME2":1,"MD":10,"MA":11,"MI":16,"MN":10,"MS":6,"MO":10,"MT":3,"NE":2,"NE1":1,"NE2":1,"NE3":1,"NV":6,"NH":4,"NJ":14,"NM":5,"NY":29,"NC":15,"ND":3,"OH":18,"OK":7,"OR":7,"PA":20,"RI":4,"SC":9,"SD":3,"TN":11,"TX":38,"UT":6,"VT":3,"VA":13,"WA":12,"WV":5,"WI":10,"WY":3};
const RAW_STATE_NAME_FROM_FULL = {"Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO","Connecticut":"CT","Delaware":"DE","District of Columbia":"DC","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA","Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN","Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY"};
const RAW_ME_NE_LEANS = {
    "ME1":  0.0537,
    "ME2": -0.0605,
    "NE1":  0.0237,
    "NE2":  0.109,
    "NE3": -0.139
};

// Bookkeeping for the original forecast
let simulations = [];
let stateNames = [];
let stateEvs = [];
let originalDemEvs = [];
let originalNatlPopVote = [];
let originalStatePercents = [];

// Statistical information for resampling
let resampleMu;
let resampleSigma;
let resampleDistribution;
let resampled;

// Visualization constants
const stateLikelihoodScale = d3.scaleThreshold()
    .domain([0.01, 0.15, 0.35, 0.65, 0.85, 0.99])
    .range(['#F8626B', '#F8ABA8', '#FFDEDC', '#EEE', '#CCD7F3', '#9BACD8', '#717CBA']);

// User-configurable data for the simulations
let configSamples = 10000;
let configAutorun = true;
let forceBidenStates = [];
let forceTrumpStates = [];

// Immediately start!
(async function () {
    // Read information from the URL
    parseUrlParameters();

    // Precompute the resampling distribution
    await initializeDistribution();

    // Initialize the interactive
    await initializeInteractive();

    // Get a baseline forecast
    updateForecast();

    // Update the interactive
    await updateInteractive();

    // Update the URL
    updateUrlParameters();
})();

function parseUrlParameters() {
    if (!location.search)
        return;

    const params = {};
    location.search.substr(1)
        .split('&')
        .map(kv => kv.split('='))
        .forEach(pair => params[pair[0]] = pair[1]);

    const samples = parseInt(params.samples);
    if (samples && samples >= 10000 && samples <= 100000) {
        configSamples = samples;
        document.querySelector('#config-samples').value = configSamples;
    }

    const notAutorun = params.autorun === 'false';
    if (notAutorun) {
        configAutorun = false;
        document.querySelector('#config-autorun').checked = false;
    }

    if (params.biden) {
        forceBidenStates = params.biden.split(',');
    }

    if (params.trump) {
        forceTrumpStates = params.trump.split(',');
    }
}

function updateUrlParameters() {
    const params = [];

    if (forceBidenStates.length) {
        params.push(`biden=${forceBidenStates.join(',')}`);
    }

    if (forceTrumpStates.length) {
        params.push(`trump=${forceTrumpStates.join(',')}`);
    }

    if (configSamples !== DEFAULT_SAMPLES) {
        params.push(`samples=${configSamples}`);
    }

    if (configAutorun !== DEFAULT_AUTORUN) {
        params.push(`autorun=${configAutorun}`);
    }

    history.replaceState(null, null, '?' + params.join('&'));
}

async function initializeInteractive() {
    const us = await d3.json('https://cdn.jsdelivr.net/npm/us-atlas@3.0.0/states-albers-10m.json');
    window.us = us;
    const path = d3.geoPath();
    const svg = d3.select('#map')
        .attr("viewBox", [0, 0, 975, 610]);

    const tooltip = d3.select('#tooltip');

    // Create a cross-hatch pattern for picked states
    svg.append('defs')
        .append('pattern')
            .attr('id', 'diagonalHatch')
            .attr('patternUnits', 'userSpaceOnUse')
            .attr('width', 8)
            .attr('height', 8)
        .append('path')
            .attr('d', 'M-1,-1 l14,14')
            .attr('stroke', '#000000')
            .attr('stroke-width', 1);

    // Interior outline of all states and the country
    svg.append("path")
        .datum(topojson.mesh(us, us.objects.states, (a, b) => a !== b))
        .attr("fill", "none")
        .attr("stroke", "white")
        .attr("stroke-linejoin", "round")
        .attr("pointer-events", "none")
        .attr("d", path);

    // Map shapes for each state
    const statesShape = svg.append("g")
        .attr("fill", "#ccc")
        .selectAll("path")
            .data(topojson.feature(us, us.objects.states).features)
            .enter();
            
    // State shapes
    statesShape.append("path")
        .attr('class', 'map-state')
        .attr('d', path)
        .attr('stroke', 'white')
        .attr('stroke-linejoin', 'round')
        .on("click", (event, d) => {
            const stateName = RAW_STATE_NAME_FROM_FULL[d.properties.name];
            attemptForecastAndInteractiveUpdate(() => toggleConstraintState(stateName));
        })
        .on('mouseover', (event, d) => {
            const stateName = RAW_STATE_NAME_FROM_FULL[d.properties.name];
            const stateProbability = resampled.forecast.bidenStatesProbability[stateName];
            tooltip
                .style('display', 'block')
                .style('top', `${event.clientY - 150}px`)
                .style('left', `${event.clientX - 75}px`);
            tooltip.select('#state').text(stateName);
            tooltip.select('#biden-probability').text(math.round(stateProbability * 100, 1) + '%');
            tooltip.select('#trump-probability').text(math.round((1 - stateProbability) * 100, 1) + '%');
        })
        .on('mousemove', (event, d) => {
            const stateName = RAW_STATE_NAME_FROM_FULL[d.properties.name];
            const stateProbability = resampled.forecast.bidenStatesProbability[stateName];
            tooltip
                .style('display', 'block')
                .style('top', `${event.clientY - 150}px`)
                .style('left', `${event.clientX - 75}px`);
            tooltip.select('#state').text(stateName);
            tooltip.select('#biden-probability').text(math.round(stateProbability * 100, 1) + '%');
            tooltip.select('#trump-probability').text(math.round((1 - stateProbability) * 100, 1) + '%');
        })
        .on('mouseleave', (event, d) => {
            tooltip.style('display', 'none');
        });

    // Outlines for picked states
    statesShape.append('path')
        .attr('class', 'map-state-outline')
        .attr('d', path)
        .attr('pointer-events', 'none')
        .attr('fill', 'none')
        .attr('stroke', 'none')
        .attr('stroke-width', 2)
        .attr('stroke-linejoin', 'round')

    // Create the list of states
    const statesList = d3.select('#states')
        .append('div')
            .classed('grid', true)
        .selectAll('.state')
        .data(stateNames.slice().sort())
        .enter()
            .append('div')
            .classed('state', true)
            .classed('biden', d => forceBidenStates.includes(d))
            .classed('trump', d => forceTrumpStates.includes(d))
            .text(d => d);

    // Add toggles for each of the candidates
    statesList.append('div')
        .classed('toggle', true)
        .classed('toggle-biden', true)
        .on('click', (event, d) => attemptForecastAndInteractiveUpdate(() => forceConstraintState(d, 'biden')))
        .append('img')
            .attr('src', 'https://cdn.economistdatateam.com/us-2020-forecast/static/biden-head.png');
    
    statesList.append('div')
        .classed('toggle', true)
        .classed('toggle-trump', true)
        .on('click', (event, d) => attemptForecastAndInteractiveUpdate(() => forceConstraintState(d, 'trump')))
        .append('img')
            .attr('src', 'https://cdn.economistdatateam.com/us-2020-forecast/static/trump-head.png');

    // Handle configuration changes
    d3.select('#config-samples').on('change', event => {
        configSamples = parseInt(event.target.value);
        updateUrlParameters();
    });
    d3.select('#config-autorun').on('change', event => {
        configAutorun = event.target.checked;
        updateUrlParameters();
    });
    d3.select('#action-run').on('click', () => attemptForecastAndInteractiveUpdate(null, true));
    d3.select('#action-reset').on('click', () => {
        forceBidenStates = [];
        forceTrumpStates = [];
        attemptForecastAndInteractiveUpdate(null, true);
    });
}

async function updateInteractive() {
    d3.select('#map')
        .selectAll('.map-state')
        .transition()
            .duration(300)
            .delay((d, i) => {
                // Update constraint states immediately 
                const stateName = RAW_STATE_NAME_FROM_FULL[d.properties.name];

                if (forceBidenStates.includes(stateName) || forceTrumpStates.includes(stateName)) {
                    return 0;
                } else {
                    return (i + 1) * 20;
                }
            })
        .attr("fill", d => {
            const stateName = RAW_STATE_NAME_FROM_FULL[d.properties.name];
            return stateLikelihoodScale(resampled.forecast.bidenStatesProbability[stateName]);
        });


    d3.select('#map')
        .selectAll('.map-state-outline')
        .transition()
            .duration(300)
        .attr('fill', d => {
            const stateName = RAW_STATE_NAME_FROM_FULL[d.properties.name];

            if (forceBidenStates.includes(stateName) || forceTrumpStates.includes(stateName)) {
                return 'url(#diagonalHatch)';
            } else {
                return 'none';
            }
        });

    const bidenInfo = d3.select('#information .biden');
    bidenInfo.classed('winner', resampled.forecast.bidenWinsProbability >= 0.5);
    bidenInfo.select('.probability-win').text(math.round(resampled.forecast.bidenWinsProbability * 100, 1) + '%');
    bidenInfo.select('.expected-ev').text(math.round(resampled.forecast.bidenExpectedElectoralVotes));

    const trumpInfo = d3.select('#information .trump');
    trumpInfo.classed('winner', resampled.forecast.bidenWinsProbability < 0.5);
    trumpInfo.select('.probability-win').text(math.round((1 - resampled.forecast.bidenWinsProbability) * 100, 1) + '%');
    trumpInfo.select('.expected-ev').text(math.round(538 - resampled.forecast.bidenExpectedElectoralVotes));

    
    d3.selectAll('#states .state')
        .classed('biden', d => forceBidenStates.includes(d))
        .classed('trump', d => forceTrumpStates.includes(d));

    d3.selectAll('.toggle-biden')
        .classed('active', d => forceBidenStates.includes(d));

    d3.selectAll('.toggle-trump')
        .classed('active', d => forceTrumpStates.includes(d))
}

function attemptForecastAndInteractiveUpdate(prepFunction, force = false, maxAttempts = 3) {
    // Resample until there is a valid forecast
    let attempt = 0;
    while (attempt++ < maxAttempts) {
        try {
            if (prepFunction)
                prepFunction();

            // Only update the forecast if autorun is enabled disabled or this is a manual run
            if (configAutorun || force)
                updateForecast();

            break;
        } catch (error) {
            console.log(error.message);
        }
    }
            
    // Update the interactive
    updateInteractive();

    // Update the URL
    updateUrlParameters();
}

function toggleConstraintState(stateName) {
    // Toggle the state between the constraints
    if (forceBidenStates.includes(stateName)) {
        forceBidenStates = forceBidenStates.filter(value => value !== stateName);
        forceTrumpStates.push(stateName);
    } else if (forceTrumpStates.includes(stateName)) {
        forceTrumpStates = forceTrumpStates.filter(value => value !== stateName);
    } else {
        forceBidenStates.push(stateName);
    }

    console.log('Biden', forceBidenStates, 'Trump', forceTrumpStates);
}

function forceConstraintState(stateName, recipient) {
    if (recipient === 'biden') {
        if (forceTrumpStates.includes(stateName)) {
            forceTrumpStates = forceTrumpStates.filter(value => value !== stateName);
        }

        if (forceBidenStates.includes(stateName)) {
            forceBidenStates = forceBidenStates.filter(value => value !== stateName);
        } else {
            forceBidenStates.push(stateName);
        }
    } else {
        if (forceBidenStates.includes(stateName)) {
            forceBidenStates = forceBidenStates.filter(value => value !== stateName);
        }

        if (forceTrumpStates.includes(stateName)) {
            forceTrumpStates = forceTrumpStates.filter(value => value !== stateName);
        } else {
            forceTrumpStates.push(stateName);
        }
    }
}

async function initializeDistribution() {
    simulations = await d3.csv('https://cdn.economistdatateam.com/us-2020-forecast/data/president/electoral_college_simulations.csv');
    stateNames = simulations.columns.slice(Columns.STATES_START.index);

    // Process each simulation draw
    for (const draw of simulations) {
        originalDemEvs.push(parseInt(draw[Columns.DEM_EV.name]));
        originalNatlPopVote.push(parseFloat(draw[Columns.NATL_POP_VOTE.name]));

        // Parse out the ordered list of state vote percentages
        const statePercents = [];
        for (const stateName of stateNames) {
            statePercents.push(parseFloat(draw[stateName]));
        }
        originalStatePercents.push(statePercents);
    }

    // Convert data into matrices
    let simulationDemEvs = L.mat(originalDemEvs);
    let simulationNatlPopVote = L.mat(originalNatlPopVote);
    let simulationStatePercents = L.mat(originalStatePercents);

    // Simulate ME and NE using district leans relative to the statewide forecast
    stateNames.push('ME1'); simulationStatePercents = L.mat([simulationStatePercents, simulateDistrict(simulationStatePercents, 'ME', 1)], true);
    stateNames.push('ME2'); simulationStatePercents = L.mat([simulationStatePercents, simulateDistrict(simulationStatePercents, 'ME', 2)], true);
    stateNames.push('NE1'); simulationStatePercents = L.mat([simulationStatePercents, simulateDistrict(simulationStatePercents, 'NE', 1)], true);
    stateNames.push('NE2'); simulationStatePercents = L.mat([simulationStatePercents, simulateDistrict(simulationStatePercents, 'NE', 2)], true);
    stateNames.push('NE3'); simulationStatePercents = L.mat([simulationStatePercents, simulateDistrict(simulationStatePercents, 'NE', 3)], true);

    // Read and process the state electoral vote information in the correct order
    stateEvs = L.mat(stateNames.map(name => RAW_STATE_EVS[name]));

    // // Log initial probabilities
    // console.log('Initial probabilities from The Economist forecast:');
    // console.log(`Biden wins the presidency: ${math.round(L.mean(L.isGreaterOrEqual(simulationDemEvs, 270)) * 100, 2)}%`);
    // console.log(`Biden expected national popular vote: ${math.round(L.mean(simulationNatlPopVote) * 100, 2)}%`);
    // console.log();

    // console.log(`Biden wins each state: `)
    // const simulationStateWins = L.mean(L.isGreaterOrEqual(simulationStatePercents, 0.5), 2);
    // for (let si = 0; si < stateNames.length; si++) {
    //     console.log(`  ${stateNames[si]}: ${math.round(L.get(simulationStateWins, si, 0) * 100, 2)}%`);
    // }

    // Compute the mean and covariance for the states for use with the multivariate normal sampling
    console.log('Computing resampling distribution from The Economist forecast');
    resampleMu = L.mean(logit(simulationStatePercents), 2);
    resampleSigma = L.cov(L.transposeMatrix(logit(simulationStatePercents)));
    resampleDistribution = new L.Distribution(L.mvGaussian, resampleMu, resampleSigma);
}

function stateIndex(stateName) {
    return stateNames.indexOf(stateName);
}

function simulateDistrict(originalSimulation, stateName, districtNumber) {
    const stateForecast = L.getRows(originalSimulation, [stateIndex(stateName)]);
    const districtDistribution = new L.Distribution(L.Gaussian, RAW_ME_NE_LEANS[stateName + districtNumber], math.square(0.0075));
    const districtOffset = districtDistribution.sample(originalSimulation.n);
    return L.addVectors(stateForecast, districtOffset);
}

function updateForecast() {
    // Sample the multivariate normal distribution
    const { samples, samplesDrawn, samplesAccepted } = drawSamples(resampleDistribution, configSamples, 100, forceBidenStates || [], forceTrumpStates || []);

    let sampledEvs = L.isGreaterOrEqual(samples, 0.5);
    for (let row = 0; row < sampledEvs.length; row++) {
        L.setRows(sampledEvs, [row], L.entrywisemulVector(L.getRows(sampledEvs, [row]), stateEvs));
    }
    sampledEvs = L.sum(sampledEvs, 2);
    const sampledProbWinNational = L.isGreaterOrEqual(sampledEvs, 270);
    const sampledProbWinStates = L.mean(L.isGreaterOrEqual(samples, 0.5), 1);

    const bidenWinsProbability = L.mean(sampledProbWinNational);
    const bidenExpectedElectoralVotes = math.round(L.mean(sampledEvs));
    const bidenStatesProbability = {};
    stateNames.forEach((name, index) => bidenStatesProbability[name] = L.get(sampledProbWinStates, 0, index));

    // console.log(`Biden wins presidency: ${bidenWinsProbability * 100}%`);
    // console.log(`Biden expected electoral votes: ${math.round(bidenExpectedElectoralVotes)}`);
    // console.log(`Biden wins each state: `)
    // for (const stateName of stateNames) {
    //     console.log(`  ${stateName}: ${math.round(bidenStatesProbability[stateName] * 100, 2)}%`);
    // }

    resampled = { 
        constraints: {
            biden: forceBidenStates,
            trump: forceTrumpStates,
        }, 
        samples: {
            drawn: samplesDrawn,
            accepted: samplesAccepted,
        },
        forecast: {
            bidenWinsProbability, 
            bidenExpectedElectoralVotes, 
            bidenStatesProbability 
        }
    };
}

function drawSamples(distribution, nsim, nmin, bidenStates, trumpStates) {
    let proposals = expit(distribution.sample(nsim));
    let acceptedRows = [];

    function isBidenWin(row, stateName) {
        return row[stateIndex(stateName)] >= 0.5;
    }

    // Validate each sample against the Biden win/loss constraints
    for (let i = 0; i < proposals.length; i++) {
        const row = L.getRows(proposals, [i]);
        let rejected = false;

        // Reject any samples where Biden lost at least one state that was constrained as a win
        if (bidenStates) 
            rejected = rejected || bidenStates.some(stateName => !isBidenWin(row, stateName));

        // Reject any samples where Biden won at least one state that was constrained as a loss
        if (trumpStates)
            rejected = rejected || trumpStates.some(stateName => isBidenWin(row, stateName));

        // Accept or reject the sample
        if (!rejected) {
            acceptedRows.push(i);
        }
    }

    console.log(`Accepted ${acceptedRows.length} of ${nsim} samples (${math.round(acceptedRows.length / nsim * 100, 2)}%)`);

    if (acceptedRows.length < nmin) {
        console.log(acceptedRows.length, nmin);
        throw new Error('More than 99% of samples were rejected -- not a likely scenario!');
    }

    return {
        samples: L.getRows(proposals, acceptedRows),
        samplesDrawn: nsim,
        samplesAccepted: acceptedRows.length,
    };
}

function logit(Xorig) {
    return L.apply(value => math.log(value / (1 - value)), Xorig);
}

function expit(Xorig) {
    return L.apply(value => 1 / (1 + math.exp(-value)), Xorig);
}
