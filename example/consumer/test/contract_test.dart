// The consumer side of the contract.
//
// - provider fixtures: feed the responses the API really gave (../contracts/provider/,
//   verified by the provider's tests) to the client's real response handling. Where the
//   API returned a secret, the fixture holds a placeholder.
// - consumer fixtures: verify the requests the client really builds against
//   ../contracts/consumer/ (the provider's tests pass those to the real handler).
// - tables: run the shared rows through this side's calculation.
import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:contract_fixtures_example_consumer/orders_client.dart';
import 'package:test/test.dart';

final contract = ContractFixtures(
  side: ContractSide.consumer,
  dir: '../contracts',
);

/// What the app does, as a string, so the expectations below read as a table.
String outcome(ProviderFixture fixture) {
  final result = readCreateOrderResponse(
    fixture.response.status,
    fixture.response.body,
  );
  return switch (result) {
    OrderPlaced(:final totalMinor) => 'placed, total $totalMinor',
    OutOfStock(:final available) => 'out of stock, $available left',
    CouponRejected() => 'coupon rejected',
    SignInAgain() => 'sign in again',
    OrderFailed() => 'failed',
  };
}

/// Fixture name -> what the app must do when it receives that response.
const expectations = <String, String>{
  'order.created': 'placed, total 1200',
  'order.created-with-coupon': 'placed, total 899',
  'order.out-of-stock': 'out of stock, 0 left',
  'order.coupon-unknown': 'coupon rejected',
  'order.invalid-quantity': 'failed',
  'order.token-invalid': 'sign in again',
};

/// The same for the responses to "start the payment". The fixture holds a placeholder where
/// the API returned a secret; this side puts a value of its own in before the client reads it.
const paymentExpectations = <String, String>{
  'payment.started': 'confirm with the key of payment-1',
};

/// The same for the receipt, where the response headers are a part of the agreement.
const receiptExpectations = <String, String>{
  'receipt.downloaded': 'save receipt-ord_demo1.json, total 1200',
};

void main() {
  group('provider fixtures: a response whose headers matter', () {
    test('every receipt fixture has an expectation here', () {
      contract.assertCovers(
        FixtureKind.provider,
        receiptExpectations.keys,
        prefix: 'receipt.',
      );
    });

    for (final entry in receiptExpectations.entries) {
      test(entry.key, () {
        final response = contract.readResponse(entry.key).response;
        // One value per name, as this client's HTTP library would give them. (Joining is
        // right for the headers of this response; it would not be for set-cookie.)
        final headers = {
          for (final name in response.headers?.keys ?? const <String>[])
            name: response.headerValues(name).join(', '),
        };

        final result =
            readReceiptResponse(response.status, headers, response.body);

        expect(
          switch (result) {
            ReceiptReady(:final fileName, :final totalMinor) =>
              'save $fileName, total $totalMinor',
            ReceiptFailed() => 'failed',
          },
          entry.value,
        );
      });
    }
  });

  group('provider fixtures: a response with a secret in it', () {
    test('every payment fixture has an expectation here', () {
      contract.assertCovers(
        FixtureKind.provider,
        paymentExpectations.keys,
        prefix: 'payment.',
      );
    });

    for (final entry in paymentExpectations.entries) {
      test(entry.key, () {
        final fixture = contract.readResponse(entry.key);
        final body = resolvePlaceholders(
          fixture.response.body,
          (kind, name) => kind == 'key' ? 'the key of $name' : null,
        );

        final result = readStartPaymentResponse(fixture.response.status, body);

        expect(
          switch (result) {
            PaymentStarted(:final confirmKey) => 'confirm with $confirmKey',
            PaymentFailed() => 'failed',
          },
          entry.value,
        );
      });
    }
  });

  group('provider fixtures: what the app makes of real responses', () {
    test('every provider fixture has an expectation here', () {
      contract.assertCovers(
        FixtureKind.provider,
        expectations.keys,
        prefix: 'order.',
      );
    });

    for (final entry in expectations.entries) {
      test(entry.key, () {
        expect(outcome(contract.readResponse(entry.key)), entry.value);
      });
    }

    test('order.created: the id of a real response can be read', () {
      final fixture = contract.readResponse('order.created');
      final result = readCreateOrderResponse(
          fixture.response.status, fixture.response.body);
      expect((result as OrderPlaced).id, startsWith('ord_'));
    });
  });

  group('consumer fixtures: the requests the client really builds', () {
    void verify(String name, String description, ApiRequest request) {
      contract.verifyRequest(
        name: name,
        description: description,
        request: ExchangeRequest(
          method: request.method,
          path: request.path,
          headers: request.headers,
          body: request.body,
        ),
      );
    }

    test('create-order.request', () {
      verify(
        'create-order.request',
        'The request the client sends to place an order',
        buildCreateOrderRequest(
          authorization: '<token:customer-1>',
          sku: 'tea-100',
          quantity: 2,
        ),
      );
    });

    test('create-order.with-coupon.request', () {
      verify(
        'create-order.with-coupon.request',
        'The request the client sends to place an order with a coupon',
        buildCreateOrderRequest(
          authorization: '<token:customer-1>',
          sku: 'tin-300',
          quantity: 1,
          coupon: 'SAVE10',
        ),
      );
    });
  });

  group('table: order-total', () {
    for (final row in contract.readTable('order-total').rows) {
      test(row['case'], () {
        expect(
          orderTotalMinor(
            unitPriceMinor: row['unit_price_minor'] as int,
            quantity: row['quantity'] as int,
            discountPercent: row['discount_percent'] as int,
          ),
          row['expected_minor'],
        );
      });
    }
  });
}
