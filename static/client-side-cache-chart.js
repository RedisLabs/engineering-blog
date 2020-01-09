google.charts.load('current', {packages: ['corechart', 'line']});
google.charts.setOnLoadCallback(drawAll);

const raw = {
  "single_read redis.client 1000": [
    99.86964100000002,
    88.61642400000002,
    87.53603300000002,
    93.37492499999999,
    85.58999599999994
  ],
  "single_read rsacsc.client 1000": [
    114.746394,
    106.68743100000006,
    104.09577299999995,
    103.55064299999994,
    104.51507700000006
  ],
  "single_read redis.client 100": [
    8.503254999999932,
    8.870732999999964,
    8.57135100000006,
    9.713018000000018,
    8.366611999999884
  ],
  "single_read rsacsc.client 100": [
    9.8297140000001,
    0.08338800000018409,
    0.0814199999998877,
    0.08119999999989247,
    0.08084599999991227
  ],
  "eleven_reads redis.client 1000": [
    950.206174,
    935.4484219999999,
    946.3435720000004,
    930.4328329999994,
    943.3752650000002
  ],
  "eleven_reads rsacsc.client 1000": [
    103.53483300000033,
    115.70520599999989,
    115.37612099999973,
    111.02225300000069,
    111.31230900000055
  ],
  "write_and_reads redis.client 1000": [
    1023.9900439999996,
    1026.7735109999992,
    1026.496397999999,
    1014.2469659999999,
    1034.2942990000008
  ],
  "write_and_reads rsacsc.client 1000": [
    205.57468699999947,
    203.38722199999992,
    212.74219999999923,
    201.68784100000005,
    204.02559400000086
  ]
};

function avg(r, i) {
  let sum = r.reduce((a, b) => a + b[i], 0);
  sum = sum - r[0][i];
  return Number(sum/r.length).toFixed(2)
}

function drawAll() {
  drawChart(1, 'single_read', 1000);
  drawChart(2, 'single_read', 100);
  drawChart(3, 'eleven_reads', 1000);
  drawChart(4, 'write_and_reads', 1000);
}

function drawChart(n, t, c) {

  let a = `${t} redis.client ${c}`;
  let b = `${t} rsacsc.client ${c}`;
  let rows = raw[a].map((e, i) => [`Run #${i+1}`, e, raw[b][i]]);

  let data = new google.visualization.DataTable();
  data.addColumn('string', 'Run');
  data.addColumn('number', 'Regular');
  data.addColumn('number', 'Cached');
  data.addRows(rows);

  let options = {
    height: 400,
    title: `Test ${n}: ${t} on ${c} keys`,
    vAxis: {
      title: 'Time (ms)',
    },
    hAxis: {
      title: `Averages: Regular ${avg(rows,1)}ms, Cached ${avg(rows,2)}ms (excluding 1st run)`,
    },
  };

  let chart = new google.visualization.ColumnChart(document.getElementById(`chart_${n}`));

  chart.draw(data, options);

}
